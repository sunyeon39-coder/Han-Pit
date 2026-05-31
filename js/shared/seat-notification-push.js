/** FCM·OS 알림 tag — 사용자당 하나, 잠금 화면에 최신 배치만 표시 */
export const STALE_SEAT_NOTIFY_MAX_AGE_MS = 30 * 60 * 1000;

export function buildSeatNotifyTag(uid) {
  const u = String(uid || "").trim();
  return u ? `hanpit-seat-${u}` : "hanpit-seat";
}

export function seatNotificationKey(uid, data = {}) {
  return [
    String(uid || "").trim(),
    data.createdAt ?? "",
    data.seatId ?? "",
    data.eventId ?? "",
    data.boxId ?? ""
  ].join("__");
}

export function isStaleSeatNotification(createdAt, now = Date.now()) {
  const ms = Number(createdAt);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  return now - ms > STALE_SEAT_NOTIFY_MAX_AGE_MS;
}

/** 새 seat_assigned 기록 시 FCM dedup 잠금 필드 초기화 (트랜잭션-safe) */
export function seatAssignedNotificationMergeExtras() {
  return {
    fcmSeatNotifyDedupKey: "",
    fcmSeatNotifySending: ""
  };
}

/**
 * layout_notifications/{uid} 에 merge 할 seat_assigned 페이로드.
 * 동일 문서의 이전 미확인 배치는 새 createdAt·좌석으로 대체됩니다.
 */
export function buildSeatAssignedNotificationWrite(uid, fields = {}) {
  const u = String(uid || "").trim();
  const now = Number(fields.createdAt) || Date.now();
  return {
    type: "seat_assigned",
    acknowledged: false,
    supersededAt: now,
    ...fields,
    createdAt: now,
    ...seatAssignedNotificationMergeExtras()
  };
}
