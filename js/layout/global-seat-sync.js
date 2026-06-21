import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// seat-history.js(MAX_SEAT_HISTORY)와 동일하게 유지
const MAX_SEAT_HISTORY = 40;

export function buildLayoutGlobalSeatDocId(eventId, boxId, seatId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}__${String(seatId || "").trim()}`;
}

function personIdentityOf(data = {}) {
  return {
    uid: String(data.personUid || "").trim(),
    email: String(data.personEmail || "").trim(),
    name: String(data.person || "").trim()
  };
}

function isSamePersonIdentity(a, b) {
  if (a.uid && b.uid) return a.uid === b.uid;
  if (a.email && b.email) return a.email === b.email;
  return !!a.name && a.name === b.name;
}

function buildLeaveHistoryEntry(existingData = {}, leftAt = 0, reason = "clear") {
  const name = String(existingData.person || "").trim();
  if (!name) return null;
  return {
    person: name,
    personUid: String(existingData.personUid || "").trim(),
    personEmail: String(existingData.personEmail || "").trim(),
    seatedAt: Number(existingData.seatedAt) || 0,
    leftAt: Number(leftAt) || 0,
    reason: String(reason || "clear").trim()
  };
}

function appendSeatHistory(existing, entry) {
  const prev = Array.isArray(existing) ? existing.filter(Boolean) : [];
  if (!entry) return prev;
  const next = [...prev, entry];
  if (next.length <= MAX_SEAT_HISTORY) return next;
  return next.slice(next.length - MAX_SEAT_HISTORY);
}

export function mapLayoutSeatToGlobalSeatDoc(seat = {}, ctx, existingData = null, now = Date.now()) {
  const { tournamentId, eventId, boxId, eventDocId, isEmptyPerson } = ctx;
  const safeSeat = seat && typeof seat === "object" ? seat : {};
  const existing = existingData && typeof existingData === "object" ? existingData : {};

  const incomingName = String(safeSeat.person || "").trim();
  const incomingOccupied = !isEmptyPerson(incomingName) && incomingName !== "";
  const existingName = String(existing.person || "").trim();
  const existingOccupied = !isEmptyPerson(existingName) && existingName !== "";

  const samePerson =
    existingOccupied &&
    incomingOccupied &&
    isSamePersonIdentity(
      personIdentityOf(existing),
      personIdentityOf({ personUid: safeSeat.personUid, personEmail: safeSeat.personEmail, person: incomingName })
    );

  // 직접허용 admin이 layout에서 배치/교체/비우기 하면 여기서 좌석 이력을 누적해
  // 통합배치도(시스템 admin)와 동일한 seatHistory에 영구 저장한다.
  let seatHistory = Array.isArray(existing.seatHistory) ? existing.seatHistory.filter(Boolean) : [];
  if (existingOccupied && !samePerson) {
    const reason = incomingOccupied ? "replace" : "clear";
    seatHistory = appendSeatHistory(seatHistory, buildLeaveHistoryEntry(existing, now, reason));
  }

  let seatedAt;
  if (!incomingOccupied) {
    seatedAt = null;
  } else if (samePerson) {
    seatedAt = existing.seatedAt ? Number(existing.seatedAt) : safeSeat.seatedAt ? Number(safeSeat.seatedAt) : now;
  } else {
    seatedAt = safeSeat.seatedAt ? Number(safeSeat.seatedAt) : now;
  }

  return {
    seatId: String(safeSeat.id || "").trim(),
    label: String(safeSeat.label ?? safeSeat.no ?? "").trim(),
    no: Number(safeSeat.no || 0) || 0,
    order: Number(safeSeat.order || safeSeat.no || 0) || 0,
    x: Number(safeSeat.x || 0) || 0,
    y: Number(safeSeat.y || 0) || 0,
    person: incomingName,
    personUid: String(safeSeat.personUid || "").trim(),
    personEmail: String(safeSeat.personEmail || "").trim(),
    seatedAt,
    status: incomingOccupied ? "occupied" : "empty",
    tournamentId,
    mappedEventId: eventId,
    currentEventId: eventId,
    boxId,
    sourceLayoutDocId: eventDocId,
    managedByLayoutSync: true,
    updatedAt: now,
    ...(seatHistory.length ? { seatHistory } : {}),
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

    const existingBySeatId = new Map();
    existingDocs.forEach((d) => {
      const data = d.data() || {};
      const sid = String(data.seatId || "").trim();
      if (sid) existingBySeatId.set(sid, data);
    });

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
      ops.push({ kind: "set", ref: globalSeatRef, seat, existing: existingBySeatId.get(seatId) || null });
    });

    const safeEventUpdatedAt = Number(eventUpdatedAt || 0) || 0;
    // 소스 레이아웃 updatedAt 을 신뢰할 수 없거나(아직 로드 전), 좌석이 비었는데 기존 좌석이 남아 있으면
    // 로드 경합으로 좌석을 통째로 지우는 사고를 막기 위해 삭제 자체를 건너뛴다.
    const sourceTrusted = safeEventUpdatedAt > 0;
    const skipDeletes = !sourceTrusted || (safeSeats.length === 0 && existingDocs.length > 0);
    if (skipDeletes && safeSeats.length === 0 && existingDocs.length > 0) {
      console.warn(
        "[syncLayoutGlobalSeats] empty/untrusted layout — global_seats 삭제를 건너뜀",
        { eventDocId, existing: existingDocs.length, sourceTrusted }
      );
    }
    existingDocs.forEach((d) => {
      if (skipDeletes) return;
      const data = d.data() || {};
      const seatId = String(data.seatId || "").trim();
      if (!seatId || nextSeatIds.has(seatId)) return;
      if (data.managedByLayoutSync !== true) return;
      const docUpdatedAt = Number(data.updatedAt || 0) || 0;
      // 오래된 layout 탭이 newer global_seats를 지우는 것을 방지한다.
      if (docUpdatedAt > safeEventUpdatedAt) return;
      ops.push({ kind: "del", ref: d.ref });
    });

    const now = Date.now();
    const MAX_BATCH = 400;
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const slice = ops.slice(i, i + MAX_BATCH);
      const batch = writeBatch(db);
      for (const op of slice) {
        if (op.kind === "set") {
          batch.set(op.ref, mapLayoutSeatToGlobalSeatDoc(op.seat, ctx, op.existing, now), { merge: true });
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
