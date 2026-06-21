import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId } from "./dealer-attendance-refs.js";
import { applyOperationalDayToAttendance } from "../shared/attendance-operational-day.js";

export function getBaseAttendance(user) {
  if (!user) return null;
  const tournamentId = getTournamentId();
  return IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, user.uid)) || null;
}

export function isAttendanceTerminal(status) {
  const s = String(status || "").trim();
  return s === "checked_out" || s === "off";
}

/** index 이벤트 카드에 없는 eventId 의 좌석은 과거 배치 잔상으로 보고 배치중 판정에서 제외 */
export function seatStillMatchesActiveEventCard(seatInfo) {
  if (!seatInfo) return false;
  const eid = String(seatInfo.eventId || "").trim();
  if (!eid) return false;
  const events = Array.isArray(IX.events) ? IX.events : [];
  return events.some((ev) => String(ev.id || "").trim() === eid);
}

export function getDerivedAttendance(user) {
  if (!user) return null;

  const base = getBaseAttendance(user);
  const seatInfo = IX.dealerSeatMap.get(user.uid);
  /** 퇴근·미출근이면 좌석 무시 + 삭제된 카드·빈 eventId 좌석은 배치로 치지 않음 */
  const useSeat =
    Boolean(seatInfo) &&
    !(base && isAttendanceTerminal(base.status)) &&
    seatStillMatchesActiveEventCard(seatInfo);

  if (!base) {
    const seatOnly = seatInfo && seatStillMatchesActiveEventCard(seatInfo);
    return applyOperationalDayToAttendance({
      uid: user.uid,
      nickname: IX.currentUserProfile?.nickname || user.displayName || "Unknown",
      status: seatOnly ? "assigned" : "off",
      checkedInAt: null,
      checkedOutAt: null,
      breakStartedAt: null,
      totalBreakMs: 0,
      currentEventId: seatOnly ? (seatInfo.eventId || "") : "",
      currentBoxId: seatOnly ? (seatInfo.boxId || "") : "",
      currentSeatId: seatOnly ? (seatInfo.seatId || "") : "",
      currentSeatLabel: seatOnly ? (seatInfo.seatLabel || "") : "",
      updatedAt: 0
    });
  }

  return applyOperationalDayToAttendance({
    ...base,
    status: useSeat ? "assigned" : base.status,
    currentEventId: useSeat ? (seatInfo.eventId || base.currentEventId || "") : base.currentEventId || "",
    currentBoxId: useSeat ? (seatInfo.boxId || base.currentBoxId || "") : base.currentBoxId || "",
    currentSeatId: useSeat ? (seatInfo.seatId || base.currentSeatId || "") : base.currentSeatId || "",
    currentSeatLabel: useSeat ? (seatInfo.seatLabel || base.currentSeatLabel || "") : base.currentSeatLabel || ""
  });
}

export function getWorkingMs(item) {
  if (!item?.checkedInAt) return 0;
  const end = item.status === "checked_out" && item.checkedOutAt ? item.checkedOutAt : Date.now();
  const total = Math.max(0, end - Number(item.checkedInAt || 0));
  const currentBreak =
    item.status === "break" && item.breakStartedAt
      ? Math.max(0, Date.now() - Number(item.breakStartedAt || 0))
      : 0;
  return Math.max(0, total - Number(item.totalBreakMs || 0) - currentBreak);
}

export function normalizeAttendanceDoc(data = {}) {
  return {
    uid: String(data.uid || "").trim(),
    nickname: String(data.nickname || "").trim(),
    email: String(data.email || "").trim(),
    tournamentId: String(data.tournamentId || "").trim(),
    status: String(data.status || "off").trim(),
    checkedInAt: Number(data.checkedInAt || 0) || null,
    checkedOutAt: Number(data.checkedOutAt || 0) || null,
    breakStartedAt: Number(data.breakStartedAt || 0) || null,
    totalBreakMs: Number(data.totalBreakMs || 0) || 0,
    currentEventId: String(data.currentEventId || "").trim(),
    currentBoxId: String(data.currentBoxId || "").trim(),
    currentSeatId: String(data.currentSeatId || "").trim(),
    currentSeatLabel: String(data.currentSeatLabel || "").trim(),
    updatedAt: Number(data.updatedAt || 0) || 0
  };
}
