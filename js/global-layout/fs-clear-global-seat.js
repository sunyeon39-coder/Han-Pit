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
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
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
        ? findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
            uid: prevUid,
            email: prevEmail,
            name: prevName
          })
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

      tx.set(
        seatRef,
        {
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null,
          status: "empty",
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
