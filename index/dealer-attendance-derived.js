import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId } from "./dealer-attendance-refs.js";

export function getBaseAttendance(user) {
  if (!user) return null;
  const tournamentId = getTournamentId();
  return IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, user.uid)) || null;
}

export function getDerivedAttendance(user) {
  if (!user) return null;

  const base = getBaseAttendance(user);
  const seatInfo = IX.dealerSeatMap.get(user.uid);

  if (!base) {
    return {
      uid: user.uid,
      nickname: IX.currentUserProfile?.nickname || user.displayName || "Unknown",
      status: seatInfo ? "assigned" : "off",
      checkedInAt: null,
      checkedOutAt: null,
      breakStartedAt: null,
      totalBreakMs: 0,
      currentEventId: seatInfo?.eventId || "",
      currentBoxId: seatInfo?.boxId || "",
      currentSeatId: seatInfo?.seatId || "",
      currentSeatLabel: seatInfo?.seatLabel || "",
      updatedAt: 0
    };
  }

  return {
    ...base,
    status: seatInfo ? "assigned" : base.status,
    currentEventId: seatInfo?.eventId || base.currentEventId || "",
    currentBoxId: seatInfo?.boxId || base.currentBoxId || "",
    currentSeatId: seatInfo?.seatId || base.currentSeatId || "",
    currentSeatLabel: seatInfo?.seatLabel || base.currentSeatLabel || ""
  };
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
