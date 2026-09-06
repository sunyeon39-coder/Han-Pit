import {
  buildSeatAssignedNotificationWrite,
  buildSeatAssignedTargetUrl,
  buildSeatClearedNotificationWrite
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
      // layout_notifications는 여기서 건드리지 않는다 — 이 함수는 waitingUid/prevUid
      // 두 사람에 대해서만 호출되는데, waitingUid는 이 트랜잭션 뒤쪽에서 새 좌석 기준
      // seat_assigned 알림을 다시 쓰고, prevUid는 더 아래(bumpedPrevHasOtherSeat 계산 후)
      // 정확한 문맥으로 알림을 정리한다. 여기서 무조건 "seat_cleared"를 쓰면, prevUid가
      // 실제로 다른 좌석에 남아있는 경우(bumpedPrevHasOtherSeat=true, attendance는
      // "assigned"로 유지됨)에도 알림만 "seat_cleared"로 남아 서로 모순되는 상태가 됐다.
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
    targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`
  });
}

export async function assignSelectedWaitingToSeat(seatId = "") {
  releaseStuckGlobalLayoutMutationFlags();

  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId || GL.seatMutationInFlight) return;

  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const waiting = resolveSelectedWaitingForAssign();
  if (!waiting) {
    GL.selectedWaitingId = "";
    applyOptimisticMyWaitingPick("");
    flushOptimisticGlobalLayoutUi();
    throw new Error("waiting_not_found");
  }
  if (waiting.blockChecked === true) {
    throw new Error("waiting_blocked");
  }

  const rollbackOptimistic = applyOptimisticAssign({ targetSeatId, waiting, seat });
  applyOptimisticMyWaitingPick("");
  flushOptimisticGlobalLayoutUi();
  notifyOptimisticSeatAssignedForWaiting(waiting, seat, targetSeatId);
  // 화면 반영은 위에서 이미 즉시 끝났다. 서버 쪽 "내 선택 표시" 해제는 별도 쓰기로
  // 내보내지 않고, 잠시 뒤 시작하는 배정 트랜잭션 안에서 같은 문서를 쓸 때 같이 반영한다.
  // (직렬화 큐를 공유하는 별도 쓰기로 내보내면, 배정 트랜잭션이 그 쓰기가 끝날 때까지
  // 기다리게 되어 배정마다 불필요한 지연이 매번 생긴다.)

  const now = Date.now();
  const touchedProjectionKeys = new Set();

  markGlobalLayoutLocalMutation();
  let undoSeatBefore = null;
  let undoWaitingBefore = null;
  let undoFirestoreDocId = "";
  let undoSeatSnapshot = null;
  let swapReturnedJoinedAt = 0;
  let canonicalSeatEventId = "";
  let canonicalSeatBoxId = "";
  let assignEventCardLabel = "";
  let assignLogMeta = null;

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
      const prevUid = String(seatData.personUid || "").trim();
      const prevEmail = String(seatData.personEmail || "").trim();
      const prevName = String(seatData.person || "").trim();

      if (wasOccupied) {
        const seatPersonUid = String(seatData.personUid || "").trim();
        const seatPersonEmail = String(seatData.personEmail || "").trim();
        const seatEmailLc = seatPersonEmail.toLowerCase();
        const samePersonOnTargetSeat =
          (waitingUid && seatPersonUid && waitingUid === seatPersonUid) ||
          (waitingEmailLc && seatEmailLc && waitingEmailLc === seatEmailLc);
        if (samePersonOnTargetSeat) throw new Error("same_person_noop");
      }

      const waitingDupRefs = getCandidateSeatRefsForPerson(
        db,
        GL.tournamentId,
        GL.globalSeats,
        { uid: waitingUid, email: waiting.email, name: waitingName },
        targetSeatId
      );
      const prevDupRefs = wasOccupied
        ? getCandidateSeatRefsForPerson(
            db,
            GL.tournamentId,
            GL.globalSeats,
            { uid: prevUid, email: prevEmail, name: prevName },
            targetSeatId
          )
        : [];
      // 밀려나는 기존 점유자(prevUid)가 예전에 남긴 대기 문서(들) — BLOCK 상태 등을
      // 잃지 않고 재사용하려면 새로 만들기 전에 반드시 먼저 찾아봐야 한다.
      const prevWaitingRefs =
        wasOccupied && !isEmptyPerson(prevName)
          ? findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
              uid: prevUid,
              email: prevEmail,
              name: prevName
            })
          : [];

      const eventRef =
        canonicalSeatEventId && GL.tournamentId
          ? doc(db, "tournaments", GL.tournamentId, "events", canonicalSeatEventId)
          : null;

      const dupRefs = uniqueDocRefs([...waitingDupRefs, ...prevDupRefs]);

      // 배정 대상(waiting)의 대기 문서(들) — 보통 하나지만 중복 행이 있으면 여러 개일 수 있다
      const assigneeWaitingRefs = uniqueDocRefs([
        globalWaitingDocRef(db, GL.tournamentId, waitingId || makeUid("wait")),
        ...findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
          uid: waitingUid,
          email: waiting.email,
          name: waitingName
        })
      ]);
      // 이미 좌석에 앉아 있는 사람이 대기열에도 남아 있는 잔여 global_waiting 문서.
      // 배정 이외 경로(수동 좌석 추가·좌석 수정 등)로 좌석에 올라간 뒤 대기 문서가
      // 안 지워진 경우다. 배정 대상 본인과, 이번에 밀려나 대기로 돌아갈 기존 점유자는
      // 제외한다. 정상 상태에서는 배열이 비므로 추가 read 가 없다.
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
            if (
              wasOccupied &&
              !isEmptyPerson(prevName) &&
              waitingRowMatchesPerson(w, GL.tournamentId, {
                uid: prevUid,
                email: prevEmail,
                name: prevName
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
        ...prevWaitingRefs,
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
      const prevSnapOffset = assigneeSnapOffset + assigneeWaitingRefs.length;
      const prevWaitingSnaps = readSnaps.slice(prevSnapOffset, prevSnapOffset + prevWaitingRefs.length);
      const staleSnapOffset = prevSnapOffset + prevWaitingRefs.length;
      const staleSeatedWaitingSnaps = readSnaps.slice(
        staleSnapOffset,
        staleSnapOffset + staleSeatedWaitingRefs.length
      );
      const prevExistingRows = prevWaitingSnaps
        .map((s, i) => (s.exists() ? { id: prevWaitingRefs[i].id, ...s.data() } : null))
        .filter(Boolean);

      let eventCardLabel =
        getEventCardIdFromRecord({ id: canonicalSeatEventId }) || canonicalSeatEventId || "이벤트";
      if (eventSnap?.exists()) {
        eventCardLabel =
          getEventCardIdFromRecord({
            id: canonicalSeatEventId,
            cardId: (eventSnap.data() || {}).cardId
          }) || eventCardLabel;
      }
      assignEventCardLabel = eventCardLabel;

      clearDupSeatsInTransaction(
        tx,
        dupRefs,
        dupSnaps,
        { uid: waitingUid, email: waiting.email, name: waitingName },
        targetSeatId,
        now,
        touchedProjectionKeys
      );
      if (wasOccupied) {
        clearDupSeatsInTransaction(
          tx,
          dupRefs,
          dupSnaps,
          { uid: prevUid, email: prevEmail, name: prevName },
          targetSeatId,
          now,
          touchedProjectionKeys
        );
      }

      // 배정 대상의 기존 대기 문서(들) — 되돌리기용 스냅샷 + 이 트랜잭션에서 지울 목록
      const assigneeExistingRows = assigneeWaitingSnaps
        .map((s, i) => (s.exists() ? { id: assigneeWaitingRefs[i].id, ...s.data() } : null))
        .filter(Boolean);
      undoWaitingBefore = JSON.parse(JSON.stringify(assigneeExistingRows));

      // 이 트랜잭션이 이미 운영자 찜(operatorPicks) 문서도 같이 읽으니, 배정을 요청한
      // 운영자의 "내 선택 표시"도 여기서 같이 지운다. 별도 쓰기로 빼면 직렬화 큐 때문에
      // 이 트랜잭션이 그 쓰기를 기다리게 되어 배정마다 지연이 생긴다.
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

      let bumpedPrevHasOtherSeat = false;
      if (wasOccupied && !isEmptyPerson(prevName)) {
        for (let i = 0; i < dupRefs.length; i++) {
          const ds = dupSnaps[i];
          if (!ds?.exists()) continue;
          const d = ds.data() || {};
          const dName = String(d.person || "").trim();
          if (isEmptyPerson(dName)) continue;
          if (!personMatchesSeatData(d, { uid: prevUid, email: prevEmail, name: prevName })) continue;
          bumpedPrevHasOtherSeat = true;
          break;
        }
        if (!bumpedPrevHasOtherSeat) {
          swapReturnedJoinedAt = now;
        }
      }
      const prevReturnsToWaitingRow =
        wasOccupied && !isEmptyPerson(prevName) && !bumpedPrevHasOtherSeat
          ? rebuildWaitingAfterSeatToWait(
              prevExistingRows,
              GL.tournamentId,
              { uid: prevUid, email: prevEmail, name: prevName },
              now,
              {
                source: "seat_swap",
                resetJoinedAt: true,
                ...(prevExistingRows[0]?.id || prevUid
                  ? { id: prevExistingRows[0]?.id || `w_${prevUid}` }
                  : {})
              }
            )[0]
          : null;

      undoSeatSnapshot = captureSeatShellSnapshot(seat, seatData);
      undoSeatBefore = {
        person: String(seatData.person || "").trim(),
        personUid: String(seatData.personUid || "").trim(),
        personEmail: String(seatData.personEmail || "").trim(),
        seatedAt: seatData.seatedAt ? Number(seatData.seatedAt) : null,
        status: isEmptyPerson(String(seatData.person || "").trim()) ? "empty" : "occupied"
      };

      const replaceHistoryEntry = wasOccupied
        ? entryFromSeatOccupant(seatData, now, "replace")
        : null;
      const nextSeatHistory = appendSeatHistoryPatch(seatData.seatHistory, replaceHistoryEntry);

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
      // 좌석에 이미 앉아 있는데 대기열에 남아 있던 잔여 문서 정리.
      // 잘못된 상태였으므로 되돌리기(undo) 스냅샷에는 포함하지 않는다.
      for (let i = 0; i < staleSeatedWaitingRefs.length; i++) {
        if (staleSeatedWaitingSnaps[i]?.exists()) {
          tx.delete(staleSeatedWaitingRefs[i]);
        }
      }
      if (wasOccupied && !isEmptyPerson(prevName) && !bumpedPrevHasOtherSeat) {
        const { toSet: prevToSet, toDelete: prevToDelete } = diffGlobalWaitingRows(
          prevExistingRows,
          prevReturnsToWaitingRow ? [prevReturnsToWaitingRow] : []
        );
        for (const { id, data } of prevToSet) {
          tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
        }
        for (const id of prevToDelete) {
          tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
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
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            })
          },
          { merge: true }
        );
      }

      if (wasOccupied && prevUid) {
        tx.set(
          getAttendanceRef(db, GL.tournamentId, prevUid),
          {
            uid: prevUid,
            email: prevEmail,
            name: prevName,
            tournamentId: GL.tournamentId,
            status: bumpedPrevHasOtherSeat ? "assigned" : "waiting",
            statusChangedAt: now,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );

        if (!bumpedPrevHasOtherSeat) {
          tx.set(
            doc(db, "layout_notifications", prevUid),
            buildSeatClearedNotificationWrite({
              createdAt: now,
              updatedAtServer: serverTimestamp(),
              seatId: "",
              seatLabel: "",
              eventId: "",
              eventTitle: "",
              boxId: "",
              targetUrl: "",
              message: ""
            }),
            { merge: true }
          );
        }
      }

      assignLogMeta = {
        waitingUid,
        waitingName,
        wasOccupied,
        prevUid,
        prevName,
        bumpedPrevHasOtherSeat,
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
        action: "assigned",
        eventId: assignLogMeta.eventId,
        boxId: assignLogMeta.boxId,
        seatId: assignLogMeta.targetSeatId,
        seatLabel: assignLogMeta.seatLabel
      });
      if (assignLogMeta.wasOccupied && assignLogMeta.prevUid && !assignLogMeta.bumpedPrevHasOtherSeat) {
        logGlobalLayoutAttendance({
          uid: assignLogMeta.prevUid,
          nickname: assignLogMeta.prevName,
          action: "waiting",
          detail: "좌석 교체로 대기 복귀"
        });
      }
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
  scheduleSyncLayoutProjection(ev, bx);
  for (const k of touchedProjectionKeys) {
    const [e, b] = String(k || "").split("__");
    if (!e || !b) continue;
    if (e === ev && b === bx) continue;
    scheduleSyncLayoutProjection(e, b);
  }
}
