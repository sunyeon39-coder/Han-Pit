/**
 * "배치확인" 2중 확인 — admin이 seat을 고르면 즉시 Firestore에 쓰지 않고
 * 이 세션에만 있는 임시 상태로 먼저 보여준다("반전" 표시). "배치확인" 버튼을
 * 눌러야 실제 assignSelectedWaitingToSeat 이 실행돼 좌석에 반영된다.
 * 여러 관리자 화면 간에는 동기화되지 않는다(실수 방지용 로컬 안전장치).
 */
import { GL } from "./state.js";
import { assignSelectedWaitingToSeat } from "./fs-assign-waiting-to-seat.js";
import { applyOptimisticMyWaitingPick } from "./waiting-picks.js";
import { applyOptimisticAssign, flushOptimisticGlobalLayoutUi } from "./optimistic-seat-mutation.js";

export function stagePendingSeatAssignment(seatId, waiting) {
  const sid = String(seatId || "").trim();
  if (!sid || !waiting) return;
  GL.pendingSeatAssignments.set(sid, { waiting, stagedAt: Date.now() });
  GL.selectedWaitingId = "";
  applyOptimisticMyWaitingPick("");
}

export function cancelPendingSeatAssignment(seatId) {
  const sid = String(seatId || "").trim();
  if (!sid) return false;
  return GL.pendingSeatAssignments.delete(sid);
}

export function getPendingSeatAssignment(seatId) {
  return GL.pendingSeatAssignments.get(String(seatId || "").trim()) || null;
}

export function hasPendingSeatAssignments() {
  return GL.pendingSeatAssignments.size > 0;
}

/**
 * 대기 중인 모든 임시 배치를 실제 반영한다.
 * 실패한 항목은 계속 대기 상태로 남겨 admin이 다시 확인/취소할 수 있게 한다.
 *
 * 좌석 배정은 GL.seatMutationInFlight 뮤텍스로 한 번에 하나씩만 처리되므로
 * (동시에 여러 개를 병렬 실행하면 뒤쪽 요청들이 조용히 무시된다) 실제 Firestore
 * 확정은 순서대로 await 한다. 다만 그 순서 때문에 seat이 하나씩 시차를 두고
 * 화면에 반영되는 것처럼 보이지 않도록, 화면 반영(낙관적 업데이트)은 여기서
 * 전부 먼저 한 번에 끝내고 한 번만 렌더한다 — 같은 now(seatedAt)를 쓰기 때문에
 * "현재/다음" 색 전환 타이밍도 전부 동시에 시작된다.
 */
export async function confirmAllPendingSeatAssignments({ immediate = false } = {}) {
  const entries = [...GL.pendingSeatAssignments.entries()];
  const now = Date.now();

  // 실패한 항목의 낙관적 화면 반영을 되돌리기 위한 배치 시작 전 스냅샷.
  // (assignSelectedWaitingToSeat 은 skipOptimistic:true 일 때 자기 롤백을 하지 않으므로
  // 여기서 직접 관리해야 한다.)
  const preBatchSnapshot = entries.length
    ? {
        globalSeats: GL.globalSeats.map((s) => ({ ...s })),
        globalWaiting: [...GL.globalWaiting],
        selectedWaitingId: GL.selectedWaitingId,
        selectedSeatIds: new Set(GL.selectedSeatIds)
      }
    : null;

  for (const [seatId, pending] of entries) {
    const seat = GL.globalSeats.find((s) => String(s?.seatId || "").trim() === seatId);
    if (!seat) continue;
    applyOptimisticAssign({ targetSeatId: seatId, waiting: pending.waiting, seat, now, immediate });
  }
  if (entries.length) flushOptimisticGlobalLayoutUi();

  const failed = [];
  for (const [seatId, pending] of entries) {
    try {
      await assignSelectedWaitingToSeat(seatId, pending.waiting, now, { skipOptimistic: true, immediate });
      GL.pendingSeatAssignments.delete(seatId);
    } catch (err) {
      console.error("confirmAllPendingSeatAssignments:", seatId, err);
      failed.push({ seatId, waiting: pending.waiting, err });
    }
  }

  if (failed.length && preBatchSnapshot) {
    // 하나라도 실패하면 배치 시작 전 상태로 되돌린 뒤, 실제로 성공한 항목만 원래
    // 순서대로 다시 낙관적으로 반영한다. 실패 항목은 화면상으로도 Firestore에
    // 실제로 쓰여진 적 없는 배치 전 상태로 남아, "배치확인"을 다시 눌렀을 때
    // 이미 실패한 낙관적 반영을 "밀려난 이전 점유자"로 오인해 그 사람을 대기열에
    // 잘못 복귀시키는 문제를 막는다.
    GL.globalSeats = preBatchSnapshot.globalSeats;
    GL.globalWaiting = preBatchSnapshot.globalWaiting;
    GL.selectedWaitingId = preBatchSnapshot.selectedWaitingId;
    GL.selectedSeatIds = preBatchSnapshot.selectedSeatIds;

    const failedSeatIds = new Set(failed.map((f) => f.seatId));
    for (const [seatId, pending] of entries) {
      if (failedSeatIds.has(seatId)) continue;
      const seat = GL.globalSeats.find((s) => String(s?.seatId || "").trim() === seatId);
      if (!seat) continue;
      applyOptimisticAssign({ targetSeatId: seatId, waiting: pending.waiting, seat, now, immediate });
    }
    flushOptimisticGlobalLayoutUi();
  }

  return { confirmedCount: entries.length - failed.length, failed };
}
