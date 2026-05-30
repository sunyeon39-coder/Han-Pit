import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function buildLayoutGlobalSeatDocId(eventId, boxId, seatId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}__${String(seatId || "").trim()}`;
}

export function mapLayoutSeatToGlobalSeatDoc(seat = {}, ctx) {
  const { tournamentId, eventId, boxId, eventDocId, isEmptyPerson } = ctx;
  const safeSeat = seat && typeof seat === "object" ? seat : {};
  return {
    seatId: String(safeSeat.id || "").trim(),
    label: String(safeSeat.label ?? safeSeat.no ?? "").trim(),
    no: Number(safeSeat.no || 0) || 0,
    order: Number(safeSeat.order || safeSeat.no || 0) || 0,
    x: Number(safeSeat.x || 0) || 0,
    y: Number(safeSeat.y || 0) || 0,
    person: String(safeSeat.person || "").trim(),
    personUid: String(safeSeat.personUid || "").trim(),
    personEmail: String(safeSeat.personEmail || "").trim(),
    seatedAt: safeSeat.seatedAt ? Number(safeSeat.seatedAt) : null,
    status: isEmptyPerson(safeSeat.person) ? "empty" : "occupied",
    tournamentId,
    mappedEventId: eventId,
    currentEventId: eventId,
    boxId,
    sourceLayoutDocId: eventDocId,
    managedByLayoutSync: true,
    updatedAt: Date.now(),
    updatedAtServer: serverTimestamp()
  };
}

/**
 * layout_events 좌석 배열을 tournaments/{tid}/global_seats 와 동기화합니다.
 * 쓰기 권한·GLOBAL_SEATS_REF 존재 여부는 호출 측에서 검사합니다.
 */
export async function syncLayoutGlobalSeatsForCurrentLayout({
  tournamentId,
  eventId,
  boxId,
  eventDocId,
  seats = [],
  eventUpdatedAt = 0,
  isEmptyPerson
}) {
  if (!tournamentId) return;

  const ctx = { tournamentId, eventId, boxId, eventDocId, isEmptyPerson };

  try {
    const safeSeats = Array.isArray(seats) ? seats : [];
    const globalSeatsRef = collection(db, "tournaments", tournamentId, "global_seats");
    const layoutQuery = query(globalSeatsRef, where("sourceLayoutDocId", "==", eventDocId));
    const snap = await getDocs(layoutQuery);

    const existingDocs = snap.docs;

    const nextSeatIds = new Set(
      safeSeats.map((s) => String(s?.id || "").trim()).filter(Boolean)
    );

    const ops = [];
    safeSeats.forEach((seat) => {
      const seatId = String(seat?.id || "").trim();
      if (!seatId) return;
      const globalSeatRef = doc(
        db,
        "tournaments",
        tournamentId,
        "global_seats",
        buildLayoutGlobalSeatDocId(eventId, boxId, seatId)
      );
      ops.push({ kind: "set", ref: globalSeatRef, seat });
    });

    const safeEventUpdatedAt = Number(eventUpdatedAt || 0) || 0;
    existingDocs.forEach((d) => {
      const data = d.data() || {};
      const seatId = String(data.seatId || "").trim();
      if (!seatId || nextSeatIds.has(seatId)) return;
      if (data.managedByLayoutSync !== true) return;
      const docUpdatedAt = Number(data.updatedAt || 0) || 0;
      // 오래된 layout 탭이 newer global_seats를 지우는 것을 방지한다.
      if (safeEventUpdatedAt > 0 && docUpdatedAt > safeEventUpdatedAt) return;
      ops.push({ kind: "del", ref: d.ref });
    });

    const MAX_BATCH = 400;
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const slice = ops.slice(i, i + MAX_BATCH);
      const batch = writeBatch(db);
      for (const op of slice) {
        if (op.kind === "set") {
          batch.set(op.ref, mapLayoutSeatToGlobalSeatDoc(op.seat, ctx), { merge: true });
        } else {
          batch.delete(op.ref);
        }
      }
      await batch.commit();
    }
  } catch (err) {
    console.error("syncGlobalSeatsForCurrentLayout error:", err);
  }
}
