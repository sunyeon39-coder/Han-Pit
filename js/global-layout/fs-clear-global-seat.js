import { db } from "../firebase.js";
import {
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";
import { getAttendanceRef, getGlobalSeatDocRefs, isEmptyPerson, resolveSeatEventBox } from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import { syncLayoutProjection } from "./fs-layout-projection.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";

export async function clearSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;
  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const fallbackPairs = (GL.globalSeats || [])
    .filter((s) => String(s?.seatId || "").trim() === targetSeatId)
    .map((s) => resolveSeatEventBox(s));
  const seatRefs = getGlobalSeatDocRefs(seat, GL.tournamentId, fallbackPairs);
  if (!seatRefs.length) return;

  const now = Date.now();
  const waitingRef = doc(db, "layout_shared", "global_waiting");

  await runTransaction(db, async (tx) => {
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
    const seatData = seatSnap.data() || {};
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

    const [waitingSnap, ...otherSnaps] = await Promise.all([
      tx.get(waitingRef),
      ...otherRefs.map((r) => tx.get(r))
    ]);

    const waitingData = waitingSnap.exists() ? (waitingSnap.data() || {}) : { waiting: [] };
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
    let hasOtherSeat = false;

    tx.set(
      seatRef,
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
        const nextWaiting = rebuildWaitingAfterSeatToWait(waitingArr, GL.tournamentId, {
          uid: prevUid,
          email: prevEmail,
          name: prevName
        }, now);
        tx.set(
          waitingRef,
          {
            ...waitingData,
            version: 2,
            waiting: nextWaiting,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
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
        {
          type: "seat_cleared",
          acknowledged: true,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  const { eventId, boxId } = resolveSeatEventBox(seat);
  await syncLayoutProjection(eventId, boxId);
  GL.lastGlobalUndo = null;
}
