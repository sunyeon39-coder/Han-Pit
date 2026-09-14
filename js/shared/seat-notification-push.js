/** FCM·OS 알림 tag — 사용자당 하나, 잠금 화면에 최신 배치만 표시 */
export const STALE_SEAT_NOTIFY_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 통합 배치도 "교대" 타이밍 — 배치확인(seatedAt) 기준.
 * 0 ~ REVEAL: admin만 즉시 확인 가능(근무자에게는 숨김, 알림도 아직 안 감).
 * REVEAL ~ SETTLE: 근무자에게도 공개 + 배치 알림(모달·백그라운드 푸시) 발송, 5~10분 구간은 반전 표시.
 * SETTLE 이후: 교대 완료 — 정착 표시, 배치 알림 모달은 자동으로 닫힘.
 * functions/index.js 는 별도 런타임이라 같은 값을 직접 들고 있다 — 바꿀 때 같이 맞출 것.
 */
export const SEAT_SWAP_REVEAL_DELAY_MS = 5 * 60 * 1000;
export const SEAT_SWAP_SETTLE_MS = 10 * 60 * 1000;

/** notifyAt 이 아직 안 지났으면 남은 ms(양수), 지났거나 없으면 0 — 공개 시점 이전 자동 숨김용 */
export function seatNotificationDelayMs(data = {}, now = Date.now()) {
  const notifyAt = Number(data?.notifyAt);
  if (!Number.isFinite(notifyAt) || notifyAt <= 0) return 0;
  return Math.max(0, notifyAt - now);
}

/** createdAt(배치확인 시각) 기준 전체 교대 구간(SEAT_SWAP_SETTLE_MS)이 끝났는지 — 모달 자동 종료용 */
export function isSeatNotificationPastSettleWindow(data = {}, now = Date.now()) {
  const createdMs = Number(data?.createdAt);
  if (!Number.isFinite(createdMs) || createdMs <= 0) return false;
  return now - createdMs >= SEAT_SWAP_SETTLE_MS;
}

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

/**
 * layout_notifications/{uid} 에 merge 할 seat_cleared 페이로드 — 좌석이 비워졌을 때
 * (직접 비우기 / 배정 중 중복 좌석 정리 / 좌석 이동 시 중복 정리) 공통으로 사용해서,
 * 세 곳에 각자 손으로 맞춰 쓰다 필드 하나가 빠져 index/layout의 "내 배치됨" 배지가
 * 계속 남는 사고를 막는다.
 */
export function buildSeatClearedNotificationWrite(fields = {}) {
  const now = Number(fields.createdAt ?? fields.updatedAt) || Date.now();
  return {
    type: "seat_cleared",
    acknowledged: true,
    ...fields,
    updatedAt: now
  };
}

/** 근무자는 통합 배치도(global-layout.html)에서만 확인한다 */
export function buildSeatAssignedTargetUrl(tournamentId, eventId, boxId) {
  const q = new URLSearchParams();
  const t = String(tournamentId || "").trim();
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (t) q.set("tournamentId", t);
  if (e) q.set("eventId", e);
  if (b) q.set("boxId", b);
  return `./global-layout.html?${q.toString()}`;
}

/** FCM 트리거용 — await 없이 즉시 layout_notifications 기록 (트랜잭션·검증과 병렬) */
export function fireSeatAssignedPushNotification(db, docFn, setDocFn, serverTimestampFn, uid, fields = {}) {
  const u = String(uid || "").trim();
  if (!u || !db || typeof docFn !== "function" || typeof setDocFn !== "function") return;

  const body = buildSeatAssignedNotificationWrite(u, fields);
  void setDocFn(
    docFn(db, "layout_notifications", u),
    {
      ...body,
      updatedAt: Number(fields.updatedAt) || body.createdAt,
      updatedAtServer: typeof serverTimestampFn === "function" ? serverTimestampFn() : undefined
    },
    { merge: true }
  ).catch((err) => {
    console.warn("fireSeatAssignedPushNotification:", err?.code || err);
  });
}
