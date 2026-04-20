const MIN = 60 * 1000;
const TH_30 = 30 * MIN;
const TH_60 = 60 * MIN;
const TH_90 = 90 * MIN;

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function makeUid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/** 점유 좌석 해제(연속 클릭·탭) 인식 시간(ms) — 짧을수록 더블 입력이 빨리 반응 */
export const LAYOUT_SEAT_DOUBLE_ACTIVATE_MS = 260;

export function isEmptyPerson(p) {
  return !p || p === "비어있음";
}

export function sanitizeLayoutState(state) {
  if (!state || typeof state !== "object") return state;

  const next = {
    ...state,
    seats: Array.isArray(state.seats) ? [...state.seats] : [],
    waiting: Array.isArray(state.waiting) ? [...state.waiting] : []
  };

  const seenSeatUid = new Set();

  next.seats = next.seats.map((seat) => {
    if (!seat || typeof seat !== "object") return seat;

    const uid = String(seat.personUid || "").trim();
    const hasPerson =
      String(seat.person || "").trim() &&
      String(seat.person || "").trim() !== "비어있음";

    if (!hasPerson) {
      return {
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      };
    }

    if (uid) {
      if (seenSeatUid.has(uid)) {
        return {
          ...seat,
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null
        };
      }
      seenSeatUid.add(uid);
    }

    return {
      ...seat,
      personUid: uid,
      personEmail: String(seat.personEmail || "").trim(),
      seatedAt: seat.seatedAt ? Number(seat.seatedAt) : Date.now()
    };
  });

  const seatUidSet = new Set(
    next.seats.map((s) => String(s?.personUid || "").trim()).filter(Boolean)
  );

  next.waiting = next.waiting.filter((w) => {
    if (!w || typeof w !== "object") return false;
    const uid = String(w.uid || "").trim();
    if (uid && seatUidSet.has(uid)) return false;
    return true;
  });

  const seenWaitingUid = new Set();
  next.waiting = next.waiting.filter((w) => {
    const uid = String(w.uid || "").trim();
    if (!uid) return true;
    if (seenWaitingUid.has(uid)) return false;
    seenWaitingUid.add(uid);
    return true;
  });

  return next;
}

export function timerClass(ms) {
  if (ms < TH_30) return "t-green";
  if (ms < TH_60) return "t-yellow";
  if (ms < TH_90) return "t-orange";
  return "t-red";
}

export function fmtElapsed(ms) {
  ms = Math.max(0, ms | 0);
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
