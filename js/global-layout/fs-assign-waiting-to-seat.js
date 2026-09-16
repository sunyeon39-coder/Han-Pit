import {
  buildSeatAssignedNotificationWrite,
  buildSeatAssignedTargetUrl,
  buildSeatClearedNotificationWrite,
  SEAT_SWAP_REVEAL_DELAY_MS
} from "../shared/seat-notification-push.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import { auth, db } from "../firebase.js";
import {
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import {
  ensureGlobalSeatFirestoreDoc,
  getAttendanceRef,
  getGlobalSeatDocRef,
  isEmptyPerson,
  makeUid,
  resolveSeatEventBox
} from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import { findGlobalWaitingEntryRefs, diffGlobalWaitingRows } from "./waiting-entry-refs.js";
import {
  globalWaitingDocRef,
  operatorPicksDocRef,
  isPersonSeatedInGlobalSeats,
  waitingRowBelongsToTournament
} from "../shared/tournament-waiting-queue.js";
import { getCurrentTournamentWaiting, resolveSelectedWaitingForAssign } from "./waiting.js";
import { renderWaiting } from "./panel-ui.js";
import {
  hasGlobalSeatForEventBox,
  scheduleEnsureLayoutEventShellDebounced,
  scheduleSyncLayoutProjection,
  validateLayoutEventForGlobalOps
} from "./fs-layout-projection.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import { buildSeatAssignedNotifyMessage } from "../shared/seat-notification-label.js";
import { rebuildWaitingAfterSeatToWait, waitingRowMatchesPerson } from "./fs-waiting-merge.js";
import { pushGlobalUndo } from "./undo-stack.js";
import { captureSeatShellSnapshot } from "./utils.js";
import { applyOptimisticMyWaitingPick, clearMyWaitingPick } from "./waiting-picks.js";
import {
  applyOptimisticAssign,
  applyOptimisticCancelIncomingSwap,
  flushOptimisticGlobalLayoutUi
} from "./optimistic-seat-mutation.js";
import { triggerOptimisticMobileSeatAssignedAlert } from "../shared/optimistic-seat-assigned-notify.js";
import { markGlobalLayoutLocalMutation, releaseStuckGlobalLayoutMutationFlags } from "./layout-mutation-guard.js";
import {
  appendSeatHistoryPatch,
  entryFromSeatOccupant
} from "./seat-history.js";
import { logGlobalLayoutAttendance } from "./attendance-log.js";
import { personIdentityMatches } from "../shared/tournament-waiting-queue.js";
import { runSerializedGlobalWaitingWrite } from "./global-waiting-write-lock.js";

function uniqueDocRefs(refs = []) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const p = String(ref?.path || "");
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(ref);
  }
  return out;
}

function personMatchesSeatData(data = {}, person = {}) {
  return personIdentityMatches(person, data);
}

function clearDupSeatsInTransaction(tx, dupRefs, dupSnaps, person, targetSeatId, now, touchedProjectionKeys) {
  const pUid = String(person.uid || "").trim();
  const pEmail = String(person.email || "").trim();
  const pName = String(person.name || "").trim();
  if (!pUid && !pEmail && !pName) return;

  for (let i = 0; i < dupRefs.length; i++) {
    const docSnap = dupSnaps[i];
    if (!docSnap?.exists()) continue;
    const data = docSnap.data() || {};
    const docSeatId = String(data.seatId || "").trim();
    if (docSeatId === targetSeatId) continue;
    if (!personMatchesSeatData(data, { uid: pUid, email: pEmail, name: pName })) continue;

    tx.set(
      dupRefs[i],
      {
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
    const kEvent = String(data.currentEventId || data.mappedEventId || "").trim();
    const kBox = String(data.boxId || "").trim();
    if (kEvent && kBox) touchedProjectionKeys.add(`${kEvent}__${kBox}`);

    // 이 중복 좌석을 비우는 것만으로는 그 사람의 dealer_attendance 문서가 갱신되지 않는다.
    // 이 좌석의 실제 점유자(uid가 있는 경우)를 기준으로 대기 상태로 동기화해 둔다 —
    // 이 사람이 이번 배정의 waiting/prevUid 당사자라면 트랜잭션 뒤쪽에서 정확한 최종
    // 상태로 다시 덮어써지고(같은 트랜잭션 내 마지막 tx.set이 적용됨), 이름만 같은
    // 제3자였다면 이 동기화가 없으면 "배치중"인데 실제로는 어디에도 없는 상태로 남는다.
    const occupantUid = String(data.personUid || "").trim();
    const occupantName = String(data.person || "").trim();
    if (occupantUid && !isEmptyPerson(occupantName)) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, occupantUid),
        {
          uid: occupantUid,
          email: String(data.personEmail || "").trim(),
          name: occupantName,
          tournamentId: GL.tournamentId,
          status: "waiting",
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  }
}

function notifyOptimisticSeatAssignedForWaiting(waiting, seat, targetSeatId) {
  const uid = String(waiting?.uid || "").trim();
  if (!uid) return;
  const { eventId, boxId } = resolveSeatEventBox(seat);
  triggerOptimisticMobileSeatAssignedAlert({
    uid,
    eventId,
    boxId,
    seatId: targetSeatId,
    seatLabel: String(seat.label || seat.no || "").trim(),
    targetUrl: buildSeatAssignedTargetUrl(GL.tournamentId, eventId, boxId)
  });
}

export async function assignSelectedWaitingToSeat(seatId = "", waitingOverride = null, nowOverride = 0, opts = {}) {
  releaseStuckGlobalLayoutMutationFlags();

  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId || GL.seatMutationInFlight) return;

  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const waiting = waitingOverride || resolveSelectedWaitingForAssign();
  if (!waiting) {
    GL.selectedWaitingId = "";
    applyOptimisticMyWaitingPick("");
    flushOptimisticGlobalLayoutUi();
    throw new Error("waiting_not_found");
  }
  if (waiting.blockChecked === true) {
    throw new Error("waiting_blocked");
  }

  const now = Number(nowOverride) || Date.now();
  // 이 좌석에 지금 실제로 앉아 있는 사람이 있으면(스왑) — 그 사람은 10분 뒤 자동 확정
  // (sendDueLayoutSeatNotifications 와 같은 방식의 서버 스케줄러, finalizeIncomingSeatSwaps)
  // 전까지 건드리지 않는다. 새 사람은 seat.incomingPerson 으로만 "대기 확정 중" 표시되고,
  // 문제가 있으면 확정 전(더블클릭)에 취소해 기존 점유자를 그대로 유지할 수 있다.
  const wasOccupiedNow = !isEmptyPerson(String(seat.person || "").trim());

  // skipOptimistic — 일괄 배치확인(confirmAllPendingSeatAssignments)에서 이미 모든
  // 대상의 화면 반영을 한 번에 끝내고 넘어온 경우. 여기서 다시 적용하면 방금 배치된
  // 사람을 "밀려난 이전 점유자"로 오인해 이중 반영되므로 건너뛴다.
  const skipOptimistic = opts?.skipOptimistic === true;
  // immediate — "즉시확인": 스왑이어도 0~10분 예약(incomingPerson) 없이 지금 바로
  // 실제 occupant를 교체하고, 알림도 5분 뒤가 아니라 즉시 발송한다.
  const immediate = opts?.immediate === true;
  const rollbackOptimistic = skipOptimistic
    ? () => {}
    : applyOptimisticAssign({ targetSeatId, waiting, seat, now, immediate });
  applyOptimisticMyWaitingPick("");
  if (!skipOptimistic) flushOptimisticGlobalLayoutUi();
  // 스왑(기존 점유자가 있는 좌석)은 아직 "진짜 배치"가 아니므로, 본인이 스스로에게
  // 교대해 들어가는 경우에도 "배치됐다" 즉시 알림은 misleading — 건너뛴다. 5분 공개
  // 시점부터는 다른 사람과 동일하게 layout_notifications 경로로 알게 된다.
  if (!wasOccupiedNow) {
    notifyOptimisticSeatAssignedForWaiting(waiting, seat, targetSeatId);
  }
  // 화면 반영은 위에서 이미 즉시 끝났다. 서버 쪽 "내 선택 표시" 해제는 별도 쓰기로
  // 내보내지 않고, 잠시 뒤 시작하는 배정 트랜잭션 안에서 같은 문서를 쓸 때 같이 반영한다.
  // (직렬화 큐를 공유하는 별도 쓰기로 내보내면, 배정 트랜잭션이 그 쓰기가 끝날 때까지
  // 기다리게 되어 배정마다 불필요한 지연이 매번 생긴다.)

  const touchedProjectionKeys = new Set();

  markGlobalLayoutLocalMutation();
  let undoSeatBefore = null;
  let undoWaitingBefore = null;
  let undoFirestoreDocId = "";
  let undoSeatSnapshot = null;
  let swapReturnedJoinedAt = 0;
  let canonicalSeatEventId = "";
  let canonicalSeatBoxId = "";
  let assignLogMeta = null;
  let wasOccupiedResolved = wasOccupiedNow;

  GL.seatMutationInFlight = true;
  try {
    const { eventId: ev0, boxId: bx0 } = resolveSeatEventBox(seat);
    const seatRefEarly = getGlobalSeatDocRef(seat, GL.tournamentId);
    if (hasGlobalSeatForEventBox(ev0, bx0, targetSeatId)) {
      scheduleEnsureLayoutEventShellDebounced(ev0, bx0);
    } else {
      const layoutGate = await validateLayoutEventForGlobalOps(ev0, bx0, {
        requireSeatId: targetSeatId,
        ensureShell: true,
        trustGlobalSeats: true
      });
      if (!layoutGate.ok) {
        rollbackOptimistic();
        flushOptimisticGlobalLayoutUi();
        alert(layoutGate.message);
        return;
      }
    }

    const fallbackPairs = (GL.globalSeats || [])
      .filter((s) => String(s?.seatId || "").trim() === targetSeatId)
      .map((s) => resolveSeatEventBox(s));

    let seatRef = seatRefEarly || getGlobalSeatDocRef(seat, GL.tournamentId);
    canonicalSeatEventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
    canonicalSeatBoxId = String(seat.boxId || "").trim();

    if (!seatRef) {
      const seatDoc = await ensureGlobalSeatFirestoreDoc(seat, GL.tournamentId, fallbackPairs);
      if (!seatDoc?.ref) throw new Error("seat_not_found");
      seatRef = seatDoc.ref;
      canonicalSeatEventId = String(
        seatDoc.data.currentEventId || seatDoc.data.mappedEventId || canonicalSeatEventId || ""
      ).trim();
      canonicalSeatBoxId = String(seatDoc.data.boxId || canonicalSeatBoxId || "").trim();
      const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
      if (idx >= 0 && seatDoc.docId) {
        GL.globalSeats[idx] = { ...GL.globalSeats[idx], __firestoreDocId: seatDoc.docId };
      }
    }
    undoFirestoreDocId = String(seatRef.id || seat.__firestoreDocId || "").trim();

    if (!canonicalSeatEventId || !canonicalSeatBoxId) {
      const fallback = resolveSeatEventBox(seat);
      canonicalSeatEventId = canonicalSeatEventId || fallback.eventId;
      canonicalSeatBoxId = canonicalSeatBoxId || fallback.boxId;
    }

    await runSerializedGlobalWaitingWrite(() => runFirestoreTransactionWithRetry(db, async (tx) => {
      const waitingId = String(waiting.id || "").trim();
      const waitingUid = String(waiting.uid || "").trim();
      const waitingEmail = String(waiting.email || "").trim();
      const waitingEmailLc = waitingEmail.toLowerCase();
      const waitingName = String(waiting.name || "").trim();

      const seatSnap = await tx.get(seatRef);
      if (!seatSnap?.exists()) throw new Error("seat_not_found");
      const seatData = seatSnap.data() || {};
      canonicalSeatEventId =
        String(seatData.currentEventId || seatData.mappedEventId || canonicalSeatEventId || "").trim();
      canonicalSeatBoxId = String(seatData.boxId || canonicalSeatBoxId || "").trim();

      const wasOccupied = !isEmptyPerson(String(seatData.person || "").trim());
      wasOccupiedResolved = wasOccupied;
      const prevUid = String(seatData.personUid || "").trim();
      const prevEmail = String(seatData.personEmail || "").trim();
      const prevName = String(seatData.person || "").trim();

      const eventRef =
        canonicalSeatEventId && GL.tournamentId
          ? doc(db, "tournaments", GL.tournamentId, "events", canonicalSeatEventId)
          : null;

      if (wasOccupied) {
        // ── 스왑: 실제 점유자는 그대로 두고, "10분 뒤 확정"으로만 예약한다 ──────────
        const seatPersonUid = String(seatData.personUid || "").trim();
        const seatPersonEmail = String(seatData.personEmail || "").trim().toLowerCase();
        const samePersonOnTargetSeat =
          (waitingUid && seatPersonUid && waitingUid === seatPersonUid) ||
          (waitingEmailLc && seatPersonEmail && waitingEmailLc === seatPersonEmail);
        if (samePersonOnTargetSeat) throw new Error("same_person_noop");

        const existingIncomingUid = String(seatData.incomingPersonUid || "").trim();
        const existingIncomingEmail = String(seatData.incomingPersonEmail || "").trim().toLowerCase();
        const existingIncomingName = String(seatData.incomingPerson || "").trim();
        const hasExistingIncoming = !isEmptyPerson(existingIncomingName);
        if (
          hasExistingIncoming &&
          ((waitingUid && existingIncomingUid && waitingUid === existingIncomingUid) ||
            (waitingEmailLc && existingIncomingEmail && waitingEmailLc === existingIncomingEmail))
        ) {
          throw new Error("same_person_noop");
        }

        const waitingDupRefs = getCandidateSeatRefsForPerson(
          db,
          GL.tournamentId,
          GL.globalSeats,
          { uid: waitingUid, email: waiting.email, name: waitingName },
          targetSeatId
        );
        const assigneeWaitingRefs = uniqueDocRefs([
          globalWaitingDocRef(db, GL.tournamentId, waitingId || makeUid("wait")),
          ...findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
            uid: waitingUid,
            email: waiting.email,
            name: waitingName
          })
        ]);
        const existingIncomingWaitingRefs = hasExistingIncoming
          ? findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
              uid: existingIncomingUid,
              email: seatData.incomingPersonEmail,
              name: existingIncomingName
            })
          : [];
        // immediate 모드 전용 — 지금 이 좌석에서 밀려나는 실제 점유자(prevXxx)가 다른
        // 좌석에도 이미 앉아있는지, 대기열에 유령 문서가 남아있는지 확인용(clearSeat과 동일한 패턴).
        const prevOtherSeatRefs = immediate
          ? getCandidateSeatRefsForPerson(
              db,
              GL.tournamentId,
              GL.globalSeats,
              { uid: prevUid, email: prevEmail, name: prevName },
              targetSeatId
            )
          : [];
        const prevWaitingRefs =
          immediate && !isEmptyPerson(prevName)
            ? findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
                uid: prevUid,
                email: prevEmail,
                name: prevName
              })
            : [];
        // 이미 어딘가 앉아 있는데 대기열에도 유령처럼 남아있는 잔여 문서 — 이번 배정
        // 당사자는 위에서 별도로 지우니 제외. 다른 경로(예: finalize 스케줄러)로 생긴
        // 잔여물도 여기서 같이 정리된다.
        const staleSeatedWaitingRefs = uniqueDocRefs(
          (GL.globalWaiting || [])
            .filter((w) => {
              const rid = String(w?.id || "").trim();
              if (!rid) return false;
              if (!waitingRowBelongsToTournament(w, GL.tournamentId)) return false;
              if (
                waitingRowMatchesPerson(w, GL.tournamentId, {
                  uid: waitingUid,
                  email: waiting.email,
                  name: waitingName
                })
              ) {
                return false;
              }
              return isPersonSeatedInGlobalSeats(GL.globalSeats, {
                uid: w?.uid,
                email: w?.email,
                name: w?.name
              });
            })
            .map((w) => globalWaitingDocRef(db, GL.tournamentId, String(w.id).trim()))
        );
        const opPicksRef = operatorPicksDocRef(db, GL.tournamentId);

        const readRefs = [
          opPicksRef,
          ...(eventRef ? [eventRef] : []),
          ...waitingDupRefs,
          ...assigneeWaitingRefs,
          ...existingIncomingWaitingRefs,
          ...prevOtherSeatRefs,
          ...prevWaitingRefs,
          ...staleSeatedWaitingRefs
        ];
        const readSnaps = await Promise.all(readRefs.map((r) => tx.get(r)));

        const opPicksSnap = readSnaps[0];
        const eventSnap = eventRef ? readSnaps[1] : null;
        const dupOffset = eventRef ? 2 : 1;
        const dupSnaps = readSnaps.slice(dupOffset, dupOffset + waitingDupRefs.length);
        const assigneeOffset = dupOffset + waitingDupRefs.length;
        const assigneeWaitingSnaps = readSnaps.slice(assigneeOffset, assigneeOffset + assigneeWaitingRefs.length);
        const existingIncomingOffset = assigneeOffset + assigneeWaitingRefs.length;
        const existingIncomingWaitingSnaps = readSnaps.slice(
          existingIncomingOffset,
          existingIncomingOffset + existingIncomingWaitingRefs.length
        );
        const prevOtherSeatOffset = existingIncomingOffset + existingIncomingWaitingRefs.length;
        const prevOtherSeatSnaps = readSnaps.slice(prevOtherSeatOffset, prevOtherSeatOffset + prevOtherSeatRefs.length);
        const prevWaitingOffset = prevOtherSeatOffset + prevOtherSeatRefs.length;
        const prevWaitingSnaps = readSnaps.slice(prevWaitingOffset, prevWaitingOffset + prevWaitingRefs.length);
        const staleSnapOffset = prevWaitingOffset + prevWaitingRefs.length;
        const staleSeatedWaitingSnaps = readSnaps.slice(
          staleSnapOffset,
          staleSnapOffset + staleSeatedWaitingRefs.length
        );

        let eventCardLabel =
          getEventCardIdFromRecord({ id: canonicalSeatEventId }) || canonicalSeatEventId || "이벤트";
        if (eventSnap?.exists()) {
          eventCardLabel =
            getEventCardIdFromRecord({
              id: canonicalSeatEventId,
              cardId: (eventSnap.data() || {}).cardId
            }) || eventCardLabel;
        }

        // 새로 배치되는 사람이 다른 좌석에 이미 앉아 있었다면(중복) 비운다.
        clearDupSeatsInTransaction(
          tx,
          waitingDupRefs,
          dupSnaps,
          { uid: waitingUid, email: waiting.email, name: waitingName },
          targetSeatId,
          now,
          touchedProjectionKeys
        );

        // 이 좌석에 이미 다른 사람이 "교대 확정 대기 중"이었다면(선택을 바꾼 경우) —
        // 그 사람을 대기로 되돌리고 새 선택으로 교체한다.
        if (hasExistingIncoming) {
          const existingIncomingRows = existingIncomingWaitingSnaps
            .map((s, i) => (s.exists() ? { id: existingIncomingWaitingRefs[i].id, ...s.data() } : null))
            .filter(Boolean);
          const restoredRow = rebuildWaitingAfterSeatToWait(
            existingIncomingRows,
            GL.tournamentId,
            { uid: existingIncomingUid, email: seatData.incomingPersonEmail, name: existingIncomingName },
            now,
            { source: "incoming_swap_replaced", resetJoinedAt: true }
          )[0];
          const { toSet, toDelete } = diffGlobalWaitingRows(
            existingIncomingRows,
            restoredRow ? [restoredRow] : []
          );
          for (const { id, data } of toSet) {
            tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
          }
          for (const id of toDelete) {
            tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
          }
        }

        const assigneeExistingRows = assigneeWaitingSnaps
          .map((s, i) => (s.exists() ? { id: assigneeWaitingRefs[i].id, ...s.data() } : null))
          .filter(Boolean);
        undoWaitingBefore = JSON.parse(JSON.stringify(assigneeExistingRows));

        const myUid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
        const opPicksData = opPicksSnap.exists() ? opPicksSnap.data() || {} : {};
        let nextOperatorPicks = opPicksData.operatorPicks;
        if (
          myUid &&
          nextOperatorPicks &&
          typeof nextOperatorPicks === "object" &&
          Object.prototype.hasOwnProperty.call(nextOperatorPicks, myUid)
        ) {
          nextOperatorPicks = { ...nextOperatorPicks };
          delete nextOperatorPicks[myUid];
        }

        undoSeatSnapshot = captureSeatShellSnapshot(seat, seatData);

        let prevHasOtherSeat = false;
        if (immediate) {
          // ── 즉시확인: 예약 없이 지금 바로 실제 occupant를 교체한다 ──────────
          prevHasOtherSeat = prevOtherSeatSnaps.some((docSnap) => {
            if (!docSnap.exists()) return false;
            const data = docSnap.data() || {};
            const dSeatId = String(data.seatId || "").trim();
            if (dSeatId === targetSeatId) return false;
            const dUid = String(data.personUid || "").trim();
            const dEmail = String(data.personEmail || "").trim().toLowerCase();
            const dName = String(data.person || "").trim();
            const sameUser =
              (prevUid && dUid && prevUid === dUid) ||
              (prevEmail.toLowerCase() && dEmail && prevEmail.toLowerCase() === dEmail) ||
              (!prevUid && !dUid && prevName && dName === prevName);
            if (!sameUser) return false;
            return !isEmptyPerson(dName);
          });

          const prevExistingWaitingRows = prevWaitingSnaps
            .map((s, i) => (s.exists() ? { id: prevWaitingRefs[i].id, ...s.data() } : null))
            .filter(Boolean);

          if (!prevHasOtherSeat) {
            swapReturnedJoinedAt = now;
            const nextPrevWaitingRows = rebuildWaitingAfterSeatToWait(
              prevExistingWaitingRows,
              GL.tournamentId,
              { uid: prevUid, email: prevEmail, name: prevName },
              now,
              { source: "seat_swap_immediate", resetJoinedAt: true }
            );
            const { toSet: prevToSet, toDelete: prevToDelete } = diffGlobalWaitingRows(
              prevExistingWaitingRows,
              nextPrevWaitingRows
            );
            for (const { id, data } of prevToSet) {
              tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
            }
            for (const id of prevToDelete) {
              tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
            }
          }

          if (prevUid) {
            tx.set(
              getAttendanceRef(db, GL.tournamentId, prevUid),
              {
                uid: prevUid,
                email: prevEmail,
                name: prevName,
                tournamentId: GL.tournamentId,
                status: prevHasOtherSeat ? "assigned" : "waiting",
                statusChangedAt: now,
                updatedAt: now,
                updatedAtServer: serverTimestamp()
              },
              { merge: true }
            );
            tx.set(
              doc(db, "layout_notifications", prevUid),
              buildSeatClearedNotificationWrite({ createdAt: now, updatedAtServer: serverTimestamp() }),
              { merge: true }
            );
          }

          undoSeatBefore = {
            person: prevName,
            personUid: prevUid,
            personEmail: prevEmail,
            seatedAt: seatData.seatedAt ? Number(seatData.seatedAt) : null,
            status: "occupied"
          };

          const historyEntry = entryFromSeatOccupant(seatData, now, "replace");
          const nextSeatHistory = appendSeatHistoryPatch(seatData.seatHistory, historyEntry);

          tx.set(
            seatRef,
            {
              person: String(waiting.name || "").trim(),
              personUid: String(waiting.uid || "").trim(),
              personEmail: String(waiting.email || "").trim(),
              seatedAt: now,
              status: "occupied",
              incomingPerson: "",
              incomingPersonUid: "",
              incomingPersonEmail: "",
              incomingAt: null,
              updatedAt: now,
              updatedAtServer: serverTimestamp(),
              ...(nextSeatHistory ? { seatHistory: nextSeatHistory } : {})
            },
            { merge: true }
          );

          if (waitingUid) {
            tx.set(
              getAttendanceRef(db, GL.tournamentId, waitingUid),
              {
                uid: waitingUid,
                email: waitingEmail,
                name: waitingName,
                tournamentId: GL.tournamentId,
                status: "assigned",
                statusChangedAt: now,
                updatedAt: now,
                updatedAtServer: serverTimestamp()
              },
              { merge: true }
            );
          }
        } else {
          undoSeatBefore = null; // 실제 occupant는 안 바뀌므로 되돌릴 게 없다 — undo 스택엔 안 올린다.

          tx.set(
            seatRef,
            {
              incomingPerson: waitingName,
              incomingPersonUid: waitingUid,
              incomingPersonEmail: waitingEmail,
              incomingAt: now,
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
            { merge: true }
          );
        }

        for (const ref of assigneeWaitingRefs) {
          tx.delete(ref);
        }
        for (let i = 0; i < staleSeatedWaitingRefs.length; i++) {
          if (staleSeatedWaitingSnaps[i]?.exists()) {
            tx.delete(staleSeatedWaitingRefs[i]);
          }
        }

        if (nextOperatorPicks !== opPicksData.operatorPicks) {
          tx.set(
            opPicksRef,
            { operatorPicks: nextOperatorPicks, updatedAt: now, updatedAtServer: serverTimestamp() },
            { merge: true }
          );
        }

        if (waitingUid) {
          tx.set(
            doc(db, "layout_notifications", waitingUid),
            {
              ...buildSeatAssignedNotificationWrite(waitingUid, {
                tournamentId: GL.tournamentId,
                eventId: canonicalSeatEventId,
                eventTitle: eventCardLabel,
                boxId: canonicalSeatBoxId,
                seatId: seat.seatId || targetSeatId,
                seatLabel: seat.label || seat.no || "",
                targetUrl: buildSeatAssignedTargetUrl(
                  GL.tournamentId,
                  canonicalSeatEventId,
                  canonicalSeatBoxId,
                  seat.seatId || targetSeatId
                ),
                message: buildSeatAssignedNotifyMessage({
                  eventId: canonicalSeatEventId,
                  cardId: eventCardLabel,
                  seatLabel: seat.label || seat.no || ""
                }),
                createdAt: now,
                notifyAt: immediate ? now : now + SEAT_SWAP_REVEAL_DELAY_MS,
                updatedAt: now,
                updatedAtServer: serverTimestamp()
              })
            },
            { merge: true }
          );
        }

        assignLogMeta = {
          waitingUid,
          waitingName,
          wasOccupied: true,
          incoming: !immediate,
          detail: immediate ? "즉시확인(0~10분 예약 없이 즉시 교대 확정)" : "",
          seatLabel: String(seat.label || seat.no || "").trim(),
          targetSeatId,
          eventId: canonicalSeatEventId,
          boxId: canonicalSeatBoxId
        };
        return;
      }

      // ── 빈 좌석에 새로 배치: 즉시 반영(스왑이 아니므로 지연시킬 대상이 없음) ──────
      const waitingDupRefs = getCandidateSeatRefsForPerson(
        db,
        GL.tournamentId,
        GL.globalSeats,
        { uid: waitingUid, email: waiting.email, name: waitingName },
        targetSeatId
      );
      const dupRefs = uniqueDocRefs(waitingDupRefs);

      const assigneeWaitingRefs = uniqueDocRefs([
        globalWaitingDocRef(db, GL.tournamentId, waitingId || makeUid("wait")),
        ...findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
          uid: waitingUid,
          email: waiting.email,
          name: waitingName
        })
      ]);
      // 이미 좌석에 앉아 있는 사람이 대기열에도 남아 있는 잔여 global_waiting 문서.
      const staleSeatedWaitingRefs = uniqueDocRefs(
        (GL.globalWaiting || [])
          .filter((w) => {
            const rid = String(w?.id || "").trim();
            if (!rid) return false;
            if (!waitingRowBelongsToTournament(w, GL.tournamentId)) return false;
            if (
              waitingRowMatchesPerson(w, GL.tournamentId, {
                uid: waitingUid,
                email: waiting.email,
                name: waitingName
              })
            ) {
              return false;
            }
            return isPersonSeatedInGlobalSeats(GL.globalSeats, {
              uid: w?.uid,
              email: w?.email,
              name: w?.name
            });
          })
          .map((w) => globalWaitingDocRef(db, GL.tournamentId, String(w.id).trim()))
      );

      const opPicksRef = operatorPicksDocRef(db, GL.tournamentId);

      const readRefs = [
        opPicksRef,
        ...(eventRef ? [eventRef] : []),
        ...dupRefs,
        ...assigneeWaitingRefs,
        ...staleSeatedWaitingRefs
      ];
      const readSnaps = await Promise.all(readRefs.map((r) => tx.get(r)));

      const opPicksSnap = readSnaps[0];
      const eventSnap = eventRef ? readSnaps[1] : null;
      const dupSnapOffset = eventRef ? 2 : 1;
      const dupSnaps = readSnaps.slice(dupSnapOffset, dupSnapOffset + dupRefs.length);
      const assigneeSnapOffset = dupSnapOffset + dupRefs.length;
      const assigneeWaitingSnaps = readSnaps.slice(
        assigneeSnapOffset,
        assigneeSnapOffset + assigneeWaitingRefs.length
      );
      const staleSnapOffset = assigneeSnapOffset + assigneeWaitingRefs.length;
      const staleSeatedWaitingSnaps = readSnaps.slice(
        staleSnapOffset,
        staleSnapOffset + staleSeatedWaitingRefs.length
      );

      let eventCardLabel =
        getEventCardIdFromRecord({ id: canonicalSeatEventId }) || canonicalSeatEventId || "이벤트";
      if (eventSnap?.exists()) {
        eventCardLabel =
          getEventCardIdFromRecord({
            id: canonicalSeatEventId,
            cardId: (eventSnap.data() || {}).cardId
          }) || eventCardLabel;
      }

      clearDupSeatsInTransaction(
        tx,
        dupRefs,
        dupSnaps,
        { uid: waitingUid, email: waiting.email, name: waitingName },
        targetSeatId,
        now,
        touchedProjectionKeys
      );

      const assigneeExistingRows = assigneeWaitingSnaps
        .map((s, i) => (s.exists() ? { id: assigneeWaitingRefs[i].id, ...s.data() } : null))
        .filter(Boolean);
      undoWaitingBefore = JSON.parse(JSON.stringify(assigneeExistingRows));

      const myUid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
      const opPicksData = opPicksSnap.exists() ? opPicksSnap.data() || {} : {};
      let nextOperatorPicks = opPicksData.operatorPicks;
      if (
        myUid &&
        nextOperatorPicks &&
        typeof nextOperatorPicks === "object" &&
        Object.prototype.hasOwnProperty.call(nextOperatorPicks, myUid)
      ) {
        nextOperatorPicks = { ...nextOperatorPicks };
        delete nextOperatorPicks[myUid];
      }

      undoSeatSnapshot = captureSeatShellSnapshot(seat, seatData);
      undoSeatBefore = {
        person: "",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty"
      };

      const nextSeatHistory = appendSeatHistoryPatch(seatData.seatHistory, null);

      tx.set(
        seatRef,
        {
          person: String(waiting.name || "").trim(),
          personUid: String(waiting.uid || "").trim(),
          personEmail: String(waiting.email || "").trim(),
          seatedAt: now,
          status: "occupied",
          updatedAt: now,
          updatedAtServer: serverTimestamp(),
          ...(nextSeatHistory ? { seatHistory: nextSeatHistory } : {})
        },
        { merge: true }
      );

      for (const ref of assigneeWaitingRefs) {
        tx.delete(ref);
      }
      for (let i = 0; i < staleSeatedWaitingRefs.length; i++) {
        if (staleSeatedWaitingSnaps[i]?.exists()) {
          tx.delete(staleSeatedWaitingRefs[i]);
        }
      }
      if (nextOperatorPicks !== opPicksData.operatorPicks) {
        tx.set(
          opPicksRef,
          { operatorPicks: nextOperatorPicks, updatedAt: now, updatedAtServer: serverTimestamp() },
          { merge: true }
        );
      }

      if (waiting.uid) {
        tx.set(
          getAttendanceRef(db, GL.tournamentId, waiting.uid),
          {
            uid: String(waiting.uid || "").trim(),
            email: String(waiting.email || "").trim(),
            name: String(waiting.name || "").trim(),
            tournamentId: GL.tournamentId,
            status: "assigned",
            statusChangedAt: now,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
      }

      if (waitingUid) {
        tx.set(
          doc(db, "layout_notifications", waitingUid),
          {
            ...buildSeatAssignedNotificationWrite(waitingUid, {
              tournamentId: GL.tournamentId,
              eventId: canonicalSeatEventId,
              eventTitle: eventCardLabel,
              boxId: canonicalSeatBoxId,
              seatId: seat.seatId || targetSeatId,
              seatLabel: seat.label || seat.no || "",
              targetUrl: buildSeatAssignedTargetUrl(
                GL.tournamentId,
                canonicalSeatEventId,
                canonicalSeatBoxId,
                seat.seatId || targetSeatId
              ),
              message: buildSeatAssignedNotifyMessage({
                eventId: canonicalSeatEventId,
                cardId: eventCardLabel,
                seatLabel: seat.label || seat.no || ""
              }),
              createdAt: now,
              notifyAt: immediate ? now : now + SEAT_SWAP_REVEAL_DELAY_MS,
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            })
          },
          { merge: true }
        );
      }

      assignLogMeta = {
        waitingUid,
        waitingName,
        wasOccupied: false,
        incoming: false,
        seatLabel: String(seat.label || seat.no || "").trim(),
        targetSeatId,
        eventId: canonicalSeatEventId,
        boxId: canonicalSeatBoxId
      };
    }));

    if (assignLogMeta) {
      logGlobalLayoutAttendance({
        uid: assignLogMeta.waitingUid,
        nickname: assignLogMeta.waitingName,
        action: assignLogMeta.incoming ? "incoming" : "assigned",
        eventId: assignLogMeta.eventId,
        boxId: assignLogMeta.boxId,
        seatId: assignLogMeta.targetSeatId,
        seatLabel: assignLogMeta.seatLabel,
        detail: assignLogMeta.detail || (assignLogMeta.incoming ? "교대 확정 대기 시작(10분 뒤 확정)" : "")
      });
    }

    flushOptimisticGlobalLayoutUi();
  } catch (err) {
    rollbackOptimistic();
    flushOptimisticGlobalLayoutUi();
    // 배정 트랜잭션이 실패하면 그 안에 같이 넣어둔 "내 선택 표시" 해제도 서버에 반영되지
    // 않는다. 화면은 이미 낙관적으로 풀린 상태이므로, 다른 운영자 화면과 어긋나지 않게
    // 최선 노력으로 별도 정리한다(성공 경로의 지연에는 영향 없음).
    void clearMyWaitingPick();
    throw err;
  } finally {
    GL.seatMutationInFlight = false;
  }

  GL.selectedWaitingId = "";
  GL.selectedSeatIds.clear();
  GL.selectedSeatIds.add(targetSeatId);
  flushOptimisticGlobalLayoutUi();
  const ev = String(canonicalSeatEventId || "").trim();
  const bx = String(canonicalSeatBoxId || "").trim();
  // 스왑(교대 확정 대기) 건은 실제 occupant가 안 바뀌므로 되돌리기 스택에 올리지 않는다 —
  // 10분 안에 마음이 바뀌면 더블클릭으로 취소(cancelIncomingSeatSwap)하는 게 정확한 경로다.
  // immediate 모드는 실제 occupant가 바로 바뀌므로 예외적으로 undo 스택에 올린다.
  if (!wasOccupiedResolved || immediate) {
    pushGlobalUndo({
      kind: "assign",
      targetSeatId,
      eventId: ev,
      boxId: bx,
      firestoreDocId: undoFirestoreDocId,
      assignedSeatedAt: now,
      swapReturnedJoinedAt,
      seatSnapshot: undoSeatSnapshot,
      waiting: JSON.parse(JSON.stringify(waiting)),
      waitingBefore: Array.isArray(undoWaitingBefore) ? undoWaitingBefore : [],
      seatBefore: undoSeatBefore || null
    });
  }
  scheduleSyncLayoutProjection(ev, bx);
  for (const k of touchedProjectionKeys) {
    const [e, b] = String(k || "").split("__");
    if (!e || !b) continue;
    if (e === ev && b === bx) continue;
    scheduleSyncLayoutProjection(e, b);
  }
}

/**
 * 교대 확정 대기 중(seat.incomingPerson)인 새 사람을 취소하고 대기로 되돌린다.
 * 실제 occupant(seat.person)는 애초에 안 바뀌었으므로 그대로 둔다 — 10분 자동 확정
 * (finalizeIncomingSeatSwaps 서버 스케줄러) 전에 문제를 발견했을 때 쓰는 경로.
 */
export async function cancelIncomingSeatSwap(seatId = "") {
  releaseStuckGlobalLayoutMutationFlags();
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId || GL.seatMutationInFlight) return;

  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;
  if (isEmptyPerson(String(seat.incomingPerson || "").trim())) return;

  const seatRef = getGlobalSeatDocRef(seat, GL.tournamentId);
  if (!seatRef) return;

  const rollbackOptimistic = applyOptimisticCancelIncomingSwap({ targetSeatId, seat });
  flushOptimisticGlobalLayoutUi();
  markGlobalLayoutLocalMutation();

  const now = Date.now();
  let cancelLogMeta = null;
  GL.seatMutationInFlight = true;
  try {
    await runSerializedGlobalWaitingWrite(() => runFirestoreTransactionWithRetry(db, async (tx) => {
      const seatSnap = await tx.get(seatRef);
      if (!seatSnap?.exists()) throw new Error("seat_not_found");
      const seatData = seatSnap.data() || {};
      const incomingUid = String(seatData.incomingPersonUid || "").trim();
      const incomingEmail = String(seatData.incomingPersonEmail || "").trim();
      const incomingName = String(seatData.incomingPerson || "").trim();
      if (isEmptyPerson(incomingName)) return;

      const incomingWaitingRefs = findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
        uid: incomingUid,
        email: incomingEmail,
        name: incomingName
      });
      const incomingWaitingSnaps = await Promise.all(incomingWaitingRefs.map((r) => tx.get(r)));
      const incomingExistingRows = incomingWaitingSnaps
        .map((s, i) => (s.exists() ? { id: incomingWaitingRefs[i].id, ...s.data() } : null))
        .filter(Boolean);
      const restoredRow = rebuildWaitingAfterSeatToWait(
        incomingExistingRows,
        GL.tournamentId,
        { uid: incomingUid, email: incomingEmail, name: incomingName },
        now,
        { source: "incoming_swap_cancelled", resetJoinedAt: true }
      )[0];
      const { toSet, toDelete } = diffGlobalWaitingRows(
        incomingExistingRows,
        restoredRow ? [restoredRow] : []
      );
      for (const { id, data } of toSet) {
        tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
      }
      for (const id of toDelete) {
        tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
      }

      tx.set(
        seatRef,
        {
          incomingPerson: "",
          incomingPersonUid: "",
          incomingPersonEmail: "",
          incomingAt: null,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      if (incomingUid) {
        tx.set(
          getAttendanceRef(db, GL.tournamentId, incomingUid),
          {
            uid: incomingUid,
            email: incomingEmail,
            name: incomingName,
            tournamentId: GL.tournamentId,
            status: "waiting",
            statusChangedAt: now,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
        // 5분 공개 알림이 아직 안 나갔으면 취소되게 확인됨으로 표시해 둔다.
        tx.set(
          doc(db, "layout_notifications", incomingUid),
          { acknowledged: true, updatedAt: now, updatedAtServer: serverTimestamp() },
          { merge: true }
        );
      }

      cancelLogMeta = { uid: incomingUid, nickname: incomingName };
    }));
  } catch (err) {
    rollbackOptimistic();
    flushOptimisticGlobalLayoutUi();
    throw err;
  } finally {
    GL.seatMutationInFlight = false;
  }

  if (cancelLogMeta) {
    logGlobalLayoutAttendance({
      uid: cancelLogMeta.uid,
      nickname: cancelLogMeta.nickname,
      action: "waiting",
      detail: "교대 확정 대기 취소"
    });
  }

  flushOptimisticGlobalLayoutUi();
}
