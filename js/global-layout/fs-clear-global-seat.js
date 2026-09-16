import { db } from "../firebase.js";
import {
  doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import {
  getAttendanceRef,
  getGlobalSeatDocRef,
  getGlobalSeatDocRefs,
  isEmptyPerson,
  resolveSeatEventBox
} from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import { findGlobalWaitingEntryRefs, diffGlobalWaitingRows } from "./waiting-entry-refs.js";
import { globalWaitingDocRef } from "../shared/tournament-waiting-queue.js";
import { buildSeatClearedNotificationWrite } from "../shared/seat-notification-push.js";
import { scheduleSyncLayoutProjection } from "./fs-layout-projection.js";
import { rebuildWaitingAfterSeatToWait, resolveCanonicalWaitingDocId } from "./fs-waiting-merge.js";
import { pushGlobalUndo } from "./undo-stack.js";
import { captureSeatShellSnapshot } from "./utils.js";
import {
  applyOptimisticClear,
  flushOptimisticGlobalLayoutUi
} from "./optimistic-seat-mutation.js";
import { markGlobalLayoutLocalMutation } from "./layout-mutation-guard.js";
import {
  appendSeatHistoryPatch,
  entryFromSeatOccupant
} from "./seat-history.js";
import { logGlobalLayoutAttendance } from "./attendance-log.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import { runSerializedGlobalWaitingWrite } from "./global-waiting-write-lock.js";

export async function clearSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId || GL.seatMutationInFlight) return;
  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;
  if (isEmptyPerson(String(seat.person || "").trim())) return;

  const fallbackPairs = (GL.globalSeats || [])
    .filter((s) => String(s?.seatId || "").trim() === targetSeatId)
    .map((s) => resolveSeatEventBox(s));

  const primaryRef = getGlobalSeatDocRef(seat, GL.tournamentId);
  const seatRefs = primaryRef ? [primaryRef] : getGlobalSeatDocRefs(seat, GL.tournamentId, fallbackPairs);
  if (!seatRefs.length) return;

  const rollbackOptimistic = applyOptimisticClear({ targetSeatId, seat });
  flushOptimisticGlobalLayoutUi();
  markGlobalLayoutLocalMutation();

  const now = Date.now();
  let undoWaitingBefore = null;
  let undoSeatBefore = null;
  let undoEventId = "";
  let undoBoxId = "";
  let undoFirestoreDocId = "";
  let undoSeatSnapshot = null;
  let returnedJoinedAt = 0;
  let clearLogMeta = null;

  GL.seatMutationInFlight = true;
  try {
    await runSerializedGlobalWaitingWrite(() => runFirestoreTransactionWithRetry(db, async (tx) => {
      let seatRef = null;
      let seatSnap = null;
      for (const ref of seatRefs) {
        const snap = await tx.get(ref);
        if (!snap.exists()) continue;
        seatRef = ref;
        seatSnap = snap;
        break;
      }
      if (!seatRef || !seatSnap?.exists()) throw new Error("seat_not_found");
      undoFirestoreDocId = String(seatRef.id || "").trim();
      const seatData = seatSnap.data() || {};
      undoSeatSnapshot = captureSeatShellSnapshot(seat, seatData);
      const prevUid = String(seatData.personUid || "").trim();
      const prevEmail = String(seatData.personEmail || "").trim();
      const prevName = String(seatData.person || "").trim();

      const otherRefs = getCandidateSeatRefsForPerson(
        db,
        GL.tournamentId,
        GL.globalSeats,
        { uid: prevUid, email: prevEmail, name: prevName },
        targetSeatId
      );
      const personWaitingRefs = !isEmptyPerson(prevName)
        ? (() => {
            // 서버(finalize)와 같은 결정적 id도 항상 같이 확인한다 — 로컬 배열이 예전에
            // 못 찾아 랜덤 id로 새로 만들었던 잔여 대기 문서가 있었다면 여기서 같이 정리된다.
            const canonicalRef = globalWaitingDocRef(
              db,
              GL.tournamentId,
              resolveCanonicalWaitingDocId({ uid: prevUid, name: prevName })
            );
            const searched = findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
              uid: prevUid,
              email: prevEmail,
              name: prevName
            });
            return searched.some((r) => r.path === canonicalRef.path)
              ? searched
              : [canonicalRef, ...searched];
          })()
        : [];

      const [otherSnaps, waitingSnaps] = await Promise.all([
        Promise.all(otherRefs.map((r) => tx.get(r))),
        Promise.all(personWaitingRefs.map((r) => tx.get(r)))
      ]);

      const existingWaitingRows = waitingSnaps
        .map((s, i) => (s.exists() ? { id: personWaitingRefs[i].id, ...s.data() } : null))
        .filter(Boolean);
      let hasOtherSeat = false;

      undoWaitingBefore = JSON.parse(JSON.stringify(existingWaitingRows));
      undoSeatBefore = {
        person: prevName,
        personUid: prevUid,
        personEmail: prevEmail,
        seatedAt: seatData.seatedAt ? Number(seatData.seatedAt) : null,
        status: "occupied"
      };
      undoEventId = String(seatData.currentEventId || seatData.mappedEventId || "").trim();
      undoBoxId = String(seatData.boxId || "").trim();

      const historyEntry = entryFromSeatOccupant(seatData, now, "clear");
      const nextHistory = appendSeatHistoryPatch(seatData.seatHistory, historyEntry);

      // 이 좌석에 "교대 확정 대기 중"(incomingPerson)인 사람이 있었다면, 좌석을 통째로
      // 비우는 이상 그 사람도 대기로 되돌린다 — 안 그러면 10분 뒤 스케줄러가 이미 없는
      // occupant를 교체하려는 어중간한 상태로 남는다.
      const incomingUid = String(seatData.incomingPersonUid || "").trim();
      const incomingEmail = String(seatData.incomingPersonEmail || "").trim();
      const incomingName = String(seatData.incomingPerson || "").trim();
      if (!isEmptyPerson(incomingName)) {
        const incomingWaitingRefs = findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
          uid: incomingUid,
          email: incomingEmail,
          name: incomingName
        });
        const incomingWaitingSnaps = await Promise.all(incomingWaitingRefs.map((r) => tx.get(r)));
        const incomingExistingRows = incomingWaitingSnaps
          .map((s, i) => (s.exists() ? { id: incomingWaitingRefs[i].id, ...s.data() } : null))
          .filter(Boolean);
        const restoredIncomingRow = rebuildWaitingAfterSeatToWait(
          incomingExistingRows,
          GL.tournamentId,
          { uid: incomingUid, email: incomingEmail, name: incomingName },
          now,
          { source: "incoming_swap_cancelled", resetJoinedAt: true }
        )[0];
        const { toSet: incomingToSet, toDelete: incomingToDelete } = diffGlobalWaitingRows(
          incomingExistingRows,
          restoredIncomingRow ? [restoredIncomingRow] : []
        );
        for (const { id, data } of incomingToSet) {
          tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
        }
        for (const id of incomingToDelete) {
          tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
        }
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
        }
      }

      tx.set(
        seatRef,
        {
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null,
          status: "empty",
          // 스왑 표시용 "이전 점유자" 필드 — merge:true라 안 지우면 그대로 남아, 좌석이
          // 실제로는 비었는데도 딜러 명단(현재/다음)이 그 사람을 계속 붙잡고 보여준다.
          previousPerson: "",
          previousPersonUid: "",
          previousPersonEmail: "",
          // 교대 확정 대기 중이던 사람도 위에서 대기로 되돌렸으니 같이 지운다.
          incomingPerson: "",
          incomingPersonUid: "",
          incomingPersonEmail: "",
          incomingAt: null,
          updatedAt: now,
          updatedAtServer: serverTimestamp(),
          ...(nextHistory ? { seatHistory: nextHistory } : {})
        },
        { merge: true }
      );

      if (!isEmptyPerson(prevName)) {
        hasOtherSeat = otherSnaps.some((docSnap) => {
          if (!docSnap.exists()) return false;
          const data = docSnap.data() || {};
          const dSeatId = String(data.seatId || "").trim();
          if (dSeatId === targetSeatId) return false;
          const dUid = String(data.personUid || "").trim();
          const dEmail = String(data.personEmail || "").trim();
          const dName = String(data.person || "").trim();
          const sameUser =
            (prevUid && dUid && prevUid === dUid) ||
            (prevEmail && dEmail && prevEmail === dEmail) ||
            (!prevUid && !prevEmail && prevName && dName === prevName);
          if (!sameUser) return false;
          return !isEmptyPerson(dName);
        });

        if (!hasOtherSeat) {
          returnedJoinedAt = now;
          const nextWaitingRows = rebuildWaitingAfterSeatToWait(
            existingWaitingRows,
            GL.tournamentId,
            { uid: prevUid, email: prevEmail, name: prevName },
            now,
            { source: "seat_clear", resetJoinedAt: true }
          );
          const { toSet, toDelete } = diffGlobalWaitingRows(existingWaitingRows, nextWaitingRows);
          for (const { id, data } of toSet) {
            tx.set(globalWaitingDocRef(db, GL.tournamentId, id), data, { merge: true });
          }
          for (const id of toDelete) {
            tx.delete(globalWaitingDocRef(db, GL.tournamentId, id));
          }
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
            status: hasOtherSeat ? "assigned" : "waiting",
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

      clearLogMeta = {
        prevUid,
        prevName,
        hasOtherSeat,
        eventId: undoEventId,
        boxId: undoBoxId,
        targetSeatId
      };
    }));
  } catch (err) {
    rollbackOptimistic();
    flushOptimisticGlobalLayoutUi();
    throw err;
  } finally {
    GL.seatMutationInFlight = false;
  }

  if (clearLogMeta?.prevUid) {
    logGlobalLayoutAttendance({
      uid: clearLogMeta.prevUid,
      nickname: clearLogMeta.prevName,
      action: clearLogMeta.hasOtherSeat ? "assigned" : "waiting",
      eventId: clearLogMeta.eventId,
      boxId: clearLogMeta.boxId,
      seatId: clearLogMeta.targetSeatId,
      detail: clearLogMeta.hasOtherSeat ? "좌석 해제 (다른 좌석 유지)" : "좌석 해제"
    });
  }

  const { eventId, boxId } = resolveSeatEventBox(seat);
  const ev = undoEventId || eventId;
  const bx = undoBoxId || boxId;
  scheduleSyncLayoutProjection(ev, bx);
  if (undoSeatBefore) {
    pushGlobalUndo({
      kind: "clear_seat",
      targetSeatId,
      eventId: ev,
      boxId: bx,
      firestoreDocId: undoFirestoreDocId,
      seatSnapshot: undoSeatSnapshot,
      seatBefore: undoSeatBefore,
      returnedJoinedAt,
      waitingBefore: Array.isArray(undoWaitingBefore) ? undoWaitingBefore : []
    });
  }
}
