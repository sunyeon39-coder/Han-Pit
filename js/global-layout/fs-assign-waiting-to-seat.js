import { buildSeatAssignedNotificationWrite, buildSeatAssignedTargetUrl } from "../shared/seat-notification-push.js";
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
  resolveSeatEventBox
} from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
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
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
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
  const waitingRef = doc(db, "layout_shared", "global_waiting");
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
      const waitingTournamentId = String(waiting.tournamentId || GL.tournamentId).trim();

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

      const eventRef =
        canonicalSeatEventId && GL.tournamentId
          ? doc(db, "tournaments", GL.tournamentId, "events", canonicalSeatEventId)
          : null;

      const dupRefs = uniqueDocRefs([...waitingDupRefs, ...prevDupRefs]);
      const readRefs = [waitingRef, ...(eventRef ? [eventRef] : []), ...dupRefs];
      const readSnaps = await Promise.all(readRefs.map((r) => tx.get(r)));

      const waitingSnap = readSnaps[0];
      const eventSnap = eventRef ? readSnaps[1] : null;
      const dupSnapOffset = eventRef ? 2 : 1;
      const dupSnaps = readSnaps.slice(dupSnapOffset);

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

      const waitingData = waitingSnap.exists() ? waitingSnap.data() || {} : { waiting: [] };
      const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
      undoWaitingBefore = JSON.parse(JSON.stringify(waitingArr));

      // 이 트랜잭션이 이미 같은 문서(global_waiting)를 읽고 쓰는 김에, 이 배정을 요청한
      // 운영자의 "내 선택 표시"도 여기서 같이 지운다. 별도 쓰기로 빼면 직렬화 큐 때문에
      // 이 트랜잭션이 그 쓰기를 기다리게 되어 배정마다 지연이 생긴다.
      const myUid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
      let nextOperatorPicks = waitingData.operatorPicks;
      if (
        myUid &&
        nextOperatorPicks &&
        typeof nextOperatorPicks === "object" &&
        Object.prototype.hasOwnProperty.call(nextOperatorPicks, myUid)
      ) {
        nextOperatorPicks = { ...nextOperatorPicks };
        delete nextOperatorPicks[myUid];
      }

      let nextWaiting = waitingArr.filter((w) => {
        if (!w || typeof w !== "object") return false;
        const wId = String(w.id || "").trim();
        const wUid = String(w.uid || "").trim();
        const wEmail = String(w.email || "").trim();
        const wName = String(w.name || "").trim();
        const wTid = String(w.tournamentId || "").trim();
        const sameTournament = !wTid || wTid === waitingTournamentId;
        if (!sameTournament) return true;
        if (waitingId && wId === waitingId) return false;
        if (waitingUid && wUid && wUid === waitingUid) return false;
        if (waitingEmail && wEmail && wEmail === waitingEmail) return false;
        if (!waitingUid && !waitingEmail && waitingName && wName === waitingName) return false;
        return true;
      });

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
          nextWaiting = rebuildWaitingAfterSeatToWait(
            nextWaiting,
            GL.tournamentId,
            { uid: prevUid, email: prevEmail, name: prevName },
            now,
            { source: "seat_swap", resetJoinedAt: true }
          );
        }
      }

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

      tx.set(
        waitingRef,
        {
          ...waitingData,
          version: 2,
          waiting: nextWaiting,
          ...(nextOperatorPicks !== waitingData.operatorPicks ? { operatorPicks: nextOperatorPicks } : {}),
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

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
            {
              type: "seat_cleared",
              acknowledged: true,
              seatId: "",
              seatLabel: "",
              eventId: "",
              eventTitle: "",
              boxId: "",
              targetUrl: "",
              message: "",
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
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
