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

function resetAttendanceToOff(attendance = {}) {
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

export function applyOperationalDayToAttendance(attendance = {}, nowMs = Date.now()) {
  const status = String(attendance?.status || "").trim();

  // 퇴근: 당일(운영일) 퇴근이면 유지. 이전 운영일 퇴근만 미출근으로 정리.
  if (status === "checked_out") {
    const checkedOutAt = Number(attendance?.checkedOutAt || 0);
    const checkedInAt = Number(attendance?.checkedInAt || 0);
    const anchor = checkedOutAt || checkedInAt;
    if (anchor && !isAttendanceFromCurrentOperationalDay({ checkedInAt: anchor }, nowMs)) {
      return resetAttendanceToOff(attendance);
    }
    return attendance;
  }

  if (status === "off") return attendance;

  if (!hasStaleOperationalDayCheckIn(attendance, nowMs)) return attendance;
  return resetAttendanceToOff(attendance);
}

/** 출석 문서 → 통합배치도 대기 타이머 앵커 (대기 시작 시각만, 출근 시각과 분리) */
export function resolveAttendanceWaitingJoinMs(attendance = {}, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const status = String(attendance?.status || "").trim();
  const checkedInAt = Number(attendance?.checkedInAt || 0);
  const statusChangedAt = Number(attendance?.statusChangedAt || 0);

  const pickIfValid = (ms) =>
    ms > 0 && isAttendanceFromCurrentOperationalDay({ checkedInAt: ms }, now) ? ms : 0;

  const waitAt = pickIfValid(statusChangedAt);
  const checkAt = pickIfValid(checkedInAt);

  // 대기열: 마지막으로 '대기' 상태가 된 시각. 없을 때만 출근 시각 폴백.
  if (status === "waiting") {
    return waitAt || checkAt || now;
  }

  // 출근 완료(배치 전): 출근 시각 우선.
  if (status === "checked_in") {
    return checkAt || waitAt || now;
  }

  return waitAt || checkAt || now;
}

/** 출석 문서의 대기 전환 시각만 (heal·비교용 — checkedInAt 제외) */
export function resolveAttendanceWaitingStatusChangedMs(attendance = {}, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const statusChangedAt = Number(attendance?.statusChangedAt || 0);
  if (
    statusChangedAt > 0 &&
    isAttendanceFromCurrentOperationalDay({ checkedInAt: statusChangedAt }, now)
  ) {
    return statusChangedAt;
  }
  return 0;
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
