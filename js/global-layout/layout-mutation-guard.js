import { GL } from "./state.js";

const DEFAULT_GUARD_MS = 12_000;

/** 로컬 삭제·배치 직후 IndexedDB 캐시 스냅샷이 UI 를 되돌리는 것 방지 */
export function markGlobalLayoutLocalMutation(ms = DEFAULT_GUARD_MS) {
  GL.localMutationUntil = Date.now() + Math.max(0, ms);
}

export function shouldIgnoreStaleGlobalLayoutSnapshot(snap) {
  if (!snap?.metadata?.fromCache) return false;
  if (snap.metadata?.hasPendingWrites) return false;
  return Date.now() < (GL.localMutationUntil || 0);
}

export function shouldSkipSeatRecoveryNow() {
  return Date.now() < (GL.skipSeatRecoveryUntil || 0);
}

export function markSkipSeatRecovery(ms = 15_000) {
  GL.skipSeatRecoveryUntil = Date.now() + Math.max(0, ms);
}

/** localMutationUntil 만료 후에도 mutation 플래그가 남으면 배치·대기 클릭이 먹통이 됨 */
export function releaseStuckGlobalLayoutMutationFlags() {
  const guardExpired = Date.now() >= (GL.localMutationUntil || 0);
  if (!guardExpired) return;
  if (GL.seatMutationInFlight) {
    console.warn("[global-layout] releasing stuck seatMutationInFlight");
    GL.seatMutationInFlight = false;
  }
  if (GL.waitingMutationInFlight) {
    console.warn("[global-layout] releasing stuck waitingMutationInFlight");
    GL.waitingMutationInFlight = false;
  }
}
