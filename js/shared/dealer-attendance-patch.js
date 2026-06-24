import {
  isActiveAttendanceStatus,
  resolveCheckedInAtForActiveStatus
} from "./attendance-operational-day.js";

/**
 * dealer_attendance merge 쓰기 전 보정 — 퇴근 후 대기/배치로 올라올 때 이전 출근 시각을 이어받지 않음
 */
export function enrichDealerAttendancePatch(prev = {}, patch = {}, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const nextStatus = String(patch.status ?? prev.status ?? "").trim();
  if (!nextStatus) return { ...patch };

  const prevStatus = String(prev.status ?? "").trim();
  const out = { ...patch };

  if (nextStatus === "checked_out") {
    out.checkedOutAt = out.checkedOutAt ?? now;
    return out;
  }

  const enteringActive =
    patch.status !== undefined &&
    isActiveAttendanceStatus(nextStatus) &&
    !isActiveAttendanceStatus(prevStatus);

  if (enteringActive) {
    out.checkedInAt = now;
    out.checkedOutAt = null;
    out.breakStartedAt = null;
    out.totalBreakMs = 0;
    out.statusChangedAt = out.statusChangedAt ?? now;
    return out;
  }

  if (
    patch.status !== undefined &&
    (nextStatus === "waiting" || nextStatus === "checked_in" || nextStatus === "break")
  ) {
    out.checkedInAt = resolveCheckedInAtForActiveStatus(prev, nextStatus, now);
    if (nextStatus !== "checked_out") {
      out.checkedOutAt = null;
    }
  }

  return out;
}
