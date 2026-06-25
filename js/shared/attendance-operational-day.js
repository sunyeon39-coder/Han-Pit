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

/** 출석 문서 → 통합배치도 대기 타이머 앵커 (운영일 내 가장 최근 시각) */
export function resolveAttendanceWaitingJoinMs(attendance = {}, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const checkedInAt = Number(attendance?.checkedInAt || 0);
  const statusChangedAt = Number(attendance?.statusChangedAt || 0);
  const candidates = [];

  for (const ms of [statusChangedAt, checkedInAt]) {
    if (ms > 0 && isAttendanceFromCurrentOperationalDay({ checkedInAt: ms }, now)) {
      candidates.push(ms);
    }
  }

  if (!candidates.length) return now;
  return Math.max(...candidates);
}

export function resolveCheckedInAtForActiveStatus(current = {}, nextStatus = "", nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  if (nextStatus !== "checked_in" && nextStatus !== "waiting" && nextStatus !== "break") {
    return Number(current?.checkedInAt || 0) || null;
  }
  // 출근하기(off/checked_out → waiting)는 항상 지금부터 새로 시작한다.
  // 같은 운영일에 퇴근했다가 다시 출근해도 예전 출근 시각(이력)을 이어받지 않는다.
  // 단, 근무 중(배치/휴식 등 active) 상태에서 대기로 돌아오는 경우는 누적 시간을 유지한다.
  if (nextStatus === "waiting" && !isActiveAttendanceStatus(current?.status)) {
    return now;
  }
  const prev = Number(current?.checkedInAt || 0);
  if (!prev) return now;
  if (isAttendanceFromCurrentOperationalDay({ checkedInAt: prev }, now)) return prev;
  return now;
}
