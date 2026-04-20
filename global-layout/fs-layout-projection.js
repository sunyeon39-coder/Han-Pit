import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";
import { getProjectionDocId, isEmptyPerson } from "./utils.js";

const tournamentEventTitleCache = new Map();

export async function resolveTournamentEventTitle(eventId = "") {
  const eid = String(eventId || "").trim();
  if (!eid || !GL.tournamentId) return eid || "이벤트";
  const key = `${GL.tournamentId}\t${eid}`;
  if (tournamentEventTitleCache.has(key)) return tournamentEventTitleCache.get(key);
  try {
    const snap = await getDoc(doc(db, "tournaments", GL.tournamentId, "events", eid));
    const title = snap.exists() ? String((snap.data() || {}).title || "").trim() : "";
    const label = title || eid;
    tournamentEventTitleCache.set(key, label);
    return label;
  } catch (err) {
    console.error("resolveTournamentEventTitle error:", err);
    tournamentEventTitleCache.set(key, eid);
    return eid;
  }
}

export async function validateLayoutEventForGlobalOps(eventId = "", boxId = "", opts = {}) {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b) {
    return { ok: false, message: "eventId와 boxId가 필요합니다." };
  }
  let snap;
  try {
    snap = await getDoc(doc(db, "layout_events", getProjectionDocId(e, b)));
  } catch (err) {
    console.error("validateLayoutEventForGlobalOps getDoc error:", err);
    return { ok: false, message: "layout_events 확인 중 오류가 났습니다." };
  }
  if (!snap.exists()) {
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout_events에 없습니다.\n\n※ index「카드 관리」에서 이 카드 ID·Box ID로 카드를 저장하면 자동으로 생성됩니다. 값이 카드와 다르지 않은지 확인하거나, layout.html에서 한 번 저장해 주세요.`
    };
  }
  const data = snap.data() || {};
  const docTid = String(data.tournamentId || "").trim();
  if (docTid && GL.tournamentId && docTid !== GL.tournamentId) {
    return { ok: false, message: "이 event/box는 현재 대회와 연결되어 있지 않습니다." };
  }
  const hasNextNo = typeof data.nextSeatNo === "number" && Number.isFinite(data.nextSeatNo);
  const hasNextOrder = typeof data.nextSeatOrder === "number" && Number.isFinite(data.nextSeatOrder);
  if (!hasNextNo && !hasNextOrder) {
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout에서 저장된 구성이 아닙니다. index·layout에서 실제 박스를 연 뒤 저장해 주세요.`
    };
  }
  const requireSeatId = String(opts.requireSeatId || "").trim();
  if (requireSeatId) {
    const seats = Array.isArray(data.seats) ? data.seats : [];
    const found = seats.some((s) => String(s?.id || "").trim() === requireSeatId);
    if (!found) {
      return {
        ok: false,
        message: "이 Seat은 배치도에 등록된 좌석이 아닙니다. 잠시 후 다시 시도하거나, layout에서 해당 Seat이 있는지 확인하세요."
      };
    }
  }
  return { ok: true };
}

export async function syncLayoutProjection(eventId = "", boxId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b || !GL.tournamentId) return;

  let liveRows = [];
  try {
    const layoutDocId = getProjectionDocId(e, b);
    const q = query(
      collection(db, "tournaments", GL.tournamentId, "global_seats"),
      where("sourceLayoutDocId", "==", layoutDocId)
    );
    const snap = await getDocs(q);
    liveRows = snap.docs.map((d) => d.data() || {});
  } catch (err) {
    console.error("syncLayoutProjection getDocs error:", err);
    liveRows = GL.globalSeats.filter((s) => {
      const eid = String(s.currentEventId || s.mappedEventId || "").trim();
      return eid === e && String(s.boxId || "").trim() === b;
    });
  }

  const seats = liveRows
    .filter((s) => {
      const eid = String(s.currentEventId || s.mappedEventId || "").trim();
      return eid === e && String(s.boxId || "").trim() === b;
    })
    .sort((a, b2) => Number(a.order || 0) - Number(b2.order || 0))
    .map((s) => ({
      id: String(s.seatId || "").trim(),
      label: String(s.label || "").trim(),
      no: Number(s.no || 0) || 0,
      order: Number(s.order || 0) || 0,
      person: isEmptyPerson(s.person) ? "비어있음" : String(s.person || "").trim(),
      personUid: String(s.personUid || "").trim(),
      personEmail: String(s.personEmail || "").trim(),
      seatedAt: s.seatedAt ? Number(s.seatedAt) : null,
      x: Number(s.x || 0) || 0,
      y: Number(s.y || 0) || 0
    }));

  await setDoc(
    doc(db, "layout_events", getProjectionDocId(e, b)),
    {
      version: 2,
      tournamentId: GL.tournamentId,
      eventId: e,
      boxId: b,
      seats,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}
