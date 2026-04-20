/** 통합 배치도(global-layout)와 동일: 대기 경과 시간 기준 시각 */
export function millisFromWaitingTimeField(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return Number(v.toMillis()) || 0;
  if (typeof v?.seconds === "number") {
    return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
}

export function getWaitingTimerStartMs(raw = {}) {
  const keys = [
    "joinedAt",
    "createdAt",
    "joinedAtServer",
    "updatedAtServer",
    "updatedAt",
    "addedAt",
    "carryStartedAt"
  ];
  for (const k of keys) {
    const ms = millisFromWaitingTimeField(raw[k]);
    if (ms > 0) return ms;
  }
  return Date.now();
}
