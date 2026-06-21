import { APP_TIME_ZONE } from "../app_config.js";
import { isEmptyPerson, getGlobalSeatSeatedAtMs, getGlobalSeatRowKey, seatCanvasDigitsOnly } from "./utils.js";
import { GL } from "./state.js";

export const MAX_SEAT_HISTORY = 40;
export const SEAT_HISTORY_LONG_PRESS_MS = 520;

export function buildSeatHistoryEntry({ person, personUid, personEmail, seatedAt, leftAt, reason }) {
  const name = String(person || "").trim();
  if (isEmptyPerson(name)) return null;
  return {
    person: name,
    personUid: String(personUid || "").trim(),
    personEmail: String(personEmail || "").trim(),
    seatedAt: Number(seatedAt) || 0,
    leftAt: Number(leftAt) || 0,
    reason: String(reason || "clear").trim()
  };
}

export function entryFromSeatOccupant(seatData = {}, leftAt, reason = "clear") {
  return buildSeatHistoryEntry({
    person: seatData.person,
    personUid: seatData.personUid,
    personEmail: seatData.personEmail,
    seatedAt: seatData.seatedAt ? Number(seatData.seatedAt) : Number(leftAt) || Date.now(),
    leftAt: Number(leftAt) || Date.now(),
    reason
  });
}

export function appendSeatHistoryPatch(existingHistory, entry) {
  if (!entry) return null;
  const prev = Array.isArray(existingHistory) ? existingHistory.filter(Boolean) : [];
  const next = [...prev, entry];
  if (next.length <= MAX_SEAT_HISTORY) return next;
  return next.slice(next.length - MAX_SEAT_HISTORY);
}

export function seatHistoryReasonLabel(reason = "") {
  const r = String(reason || "").trim();
  if (r === "replace") return "교체";
  if (r === "clear") return "비우기";
  if (r === "current") return "현재";
  return r || "-";
}

export function formatSeatHistoryWhen(ms = 0) {
  const n = Number(ms) || 0;
  if (!n) return "-";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: APP_TIME_ZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(n));
  } catch {
    return "-";
  }
}

export function formatSeatHistoryRange(seatedAt = 0, leftAt = 0) {
  const start = formatSeatHistoryWhen(seatedAt);
  if (!leftAt) return `${start} ~ 진행 중`;
  return `${start} ~ ${formatSeatHistoryWhen(leftAt)}`;
}

export function findGlobalSeatByAnyKey(key = "") {
  const k = String(key || "").trim();
  if (!k) return null;
  return (
    (GL.globalSeats || []).find((s) => {
      const sid = String(s.seatId || "").trim();
      const rowKey = getGlobalSeatRowKey(s);
      return sid === k || rowKey === k;
    }) || null
  );
}

export function getSeatHistoryView(seat = null) {
  if (!seat) return { label: "", current: null, past: [] };
  const label = seatCanvasDigitsOnly(seat.label, seat.no);
  const history = Array.isArray(seat.seatHistory) ? seat.seatHistory.filter(Boolean) : [];
  const occupied = !isEmptyPerson(String(seat.person || "").trim());
  const current = occupied
    ? {
        person: String(seat.person || "").trim(),
        personUid: String(seat.personUid || "").trim(),
        seatedAt: getGlobalSeatSeatedAtMs(seat) || Date.now(),
        leftAt: 0,
        reason: "current"
      }
    : null;
  return {
    label,
    current,
    past: [...history].reverse()
  };
}
