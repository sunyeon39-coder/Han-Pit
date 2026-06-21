import { getOperationalEventDate } from "./tournament-event-instance.js";

/** 운영일 키 (06:00~익일 05:59 → 전날 달력 날짜) */
export function getOperationalDayKey(nowMs = Date.now()) {
  return getOperationalEventDate(new Date(Number(nowMs) || Date.now()));
}

export function isActiveAttendanceStatus(status = "") {
  const s = String(status || "").trim();
  return s === "waiting" || s === "checked_in" || s === "assigned" || s === "break";
}

export function isAttendanceFromCurrentOperationalDay(attendance = {}, nowMs = Date.now()) {
  const checkedInAt = Number(attendance?.checkedInAt || 0);
  if (!checkedInAt) return true;
  return getOperationalDayKey(checkedInAt) === getOperationalDayKey(nowMs);
}

/** 출근 시각이 현재 운영일(06:00 기준)이 아닌 경우 */
export function hasStaleOperationalDayCheckIn(attendance = {}, nowMs = Date.now()) {
  const checkedInAt = Number(attendance?.checkedInAt || 0);
  if (!checkedInAt) return false;
  return !isAttendanceFromCurrentOperationalDay(attendance, nowMs);
}

/** 출근 시각이 이전 운영일인데 아직 active 상태로 남아 있는 경우 */
export function isStaleOperationalDayAttendance(attendance = {}, nowMs = Date.now()) {
  if (!attendance || typeof attendance !== "object") return false;
  if (!isActiveAttendanceStatus(attendance.status)) return false;
  return hasStaleOperationalDayCheckIn(attendance, nowMs);
}

export function applyOperationalDayToAttendance(attendance = {}, nowMs = Date.now()) {
  if (!hasStaleOperationalDayCheckIn(attendance, nowMs)) return attendance;
  return {
    ...attendance,
    status: "off",
    checkedInAt: null,
    checkedOutAt: null,
    breakStartedAt: null,
    totalBreakMs: 0,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: ""
  };
}

export function resolveCheckedInAtForActiveStatus(current = {}, nextStatus = "", nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  if (nextStatus !== "checked_in" && nextStatus !== "waiting" && nextStatus !== "break") {
    return Number(current?.checkedInAt || 0) || null;
  }
  const prev = Number(current?.checkedInAt || 0);
  if (!prev) return now;
  if (isAttendanceFromCurrentOperationalDay({ checkedInAt: prev }, now)) return prev;
  return now;
}
