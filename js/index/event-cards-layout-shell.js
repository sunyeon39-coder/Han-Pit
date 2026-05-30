import { db } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/** 카드 저장 후 통합 배치도에서 바로 Seat 추가 가능하도록 layout_events 스텁 보장 */
export async function ensureLayoutEventShellAfterCardSave({ tournamentId, eventId, boxId }) {
  const tid = String(tournamentId || "").trim();
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!tid || !eid || !bid) return;

  const ref = doc(db, "layout_events", `${eid}__${bid}`);
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    console.error("ensureLayoutEventShellAfterCardSave getDoc error:", err);
    return;
  }

  const data = snap.exists() ? snap.data() || {} : {};
  const hasNextNo = typeof data.nextSeatNo === "number" && Number.isFinite(data.nextSeatNo);
  const hasNextOrder = typeof data.nextSeatOrder === "number" && Number.isFinite(data.nextSeatOrder);
  const seats = Array.isArray(data.seats) ? data.seats : [];

  if (snap.exists() && hasNextNo && hasNextOrder) {
    const docTid = String(data.tournamentId || "").trim();
    if (tid && docTid && docTid !== tid) {
      try {
        await setDoc(
          ref,
          { tournamentId: tid, updatedAt: Date.now(), updatedAtServer: serverTimestamp() },
          { merge: true }
        );
      } catch (err) {
        console.error("ensureLayoutEventShellAfterCardSave patch tournamentId error:", err);
      }
    }
    return;
  }

  const nextSeatNo = hasNextNo ? data.nextSeatNo : 1;
  const nextSeatOrder = hasNextOrder ? data.nextSeatOrder : 1;

  try {
    await setDoc(
      ref,
      {
        version: 2,
        tournamentId: tid,
        eventId: eid,
        boxId: bid,
        nextSeatNo,
        nextSeatOrder,
        seats,
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("ensureLayoutEventShellAfterCardSave setDoc error:", err);
  }
}
