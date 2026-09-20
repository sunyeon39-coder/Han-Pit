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
 * 화면에 반영되는 것처럼 보이지 않도록 두 겹으로 막는다: (1) 화면 반영(낙관적
 * 업데이트)은 여기서 전부 먼저 한 번에 끝내고 한 번만 렌더한다 — 같은 now(seatedAt)를
 * 쓰기 때문에 "현재/다음" 색 전환 타이밍도 전부 동시에 시작된다. (2) 그 뒤 순서대로
 * 실제 저장하는 동안, 좌석 하나가 끝날 때마다 실시간 리스너가 그 좌석만 다시 반영해
 * 한 명씩 뚝뚝 들어오는 것처럼 보이지 않도록 GL.batchSeatMutationDepth로 배치 전체가
 * 끝날 때까지 실시간 반영 자체를 미뤄둔다(realtime.js의 isSeatMutationBusy 참고).
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
    // immediate("즉시확인")는 확정을 기다리는 흰색 "배치 대기 중" 표시를 거칠 이유가 없다 —
    // 낙관적 반영이 이미 최종 상태이므로 여기서 바로 지워 그 프레임부터 실제 좌석으로 보이게 한다.
    if (immediate) GL.pendingSeatAssignments.delete(seatId);
  }
  if (entries.length) flushOptimisticGlobalLayoutUi();

  // 실제 저장은 뮤텍스 때문에 좌석마다 순서대로 await 되는데, 그 사이사이 실시간
  // 리스너가 "방금 그 좌석만" 반영하며 화면이 한 명씩 뚝뚝 들어오는 것처럼 보였다.
  // 배치 전체가 끝날 때까지는 실시간 반영을 큐에 재워두고(realtime.js의
  // isSeatMutationBusy), 끝나는 순간 마지막 스냅샷 한 번으로 몰아서 반영되게 한다 —
  // 위에서 이미 낙관적으로 전부 동시에 보여줬으니 그 사이 실시간 갱신은 안 보여도 된다.
  if (entries.length) GL.batchSeatMutationDepth = (GL.batchSeatMutationDepth || 0) + 1;
  const failed = [];
  // 실제 저장 완료를 GL.pendingSeatAssignments에서 그때그때 지우면, "배치확인 (N)"
  // 버튼의 숫자가 저장 끝날 때마다 하나씩 줄어드는 게 그대로 보인다(좌석은 이미
  // 위에서 다 확정된 것처럼 보이는데 숫자만 뒤늦게 뚝뚝 떨어지면 어색하다). 배치 전체가
  // 끝난 뒤 한 번에 지워서 숫자도 좌석과 같은 타이밍에 한 번에 떨어지게 한다.
  const doneSeatIds = new Set();
  try {
    for (const [seatId, pending] of entries) {
      try {
        // waitingSnapshot — 위 낙관적 반영 루프가 이미 GL.globalWaiting에서 이 사람들을
        // 지웠으므로, 그 지우기 전 스냅샷을 넘겨야 트랜잭션 안에서 실제 대기 문서를
        // 제대로 찾아 지울 수 있다(안 그러면 문서가 안 지워진 채 대기열에 잔상으로 남는다).
        await assignSelectedWaitingToSeat(seatId, pending.waiting, now, {
          skipOptimistic: true,
          immediate,
          waitingSnapshot: preBatchSnapshot?.globalWaiting
        });
        doneSeatIds.add(seatId);
      } catch (err) {
        const msg = String(err?.message || "").trim();
        if (msg === "same_person_noop") {
          // 네트워크가 잠깐 끊겼다가 재시도되는 등으로, 이 트랜잭션이 실제로는 이미
          // 예전 시도에서 성공해서 이 사람이 이미 그 좌석에 정상 반영된 상태일 수 있다
          // (그래서 "같은 사람"이라 다시 쓸 게 없다고 거부된 것). 이걸 진짜 실패로 보고
          // 아래에서 화면을 배치 전으로 되돌리면, 이미 맞게 반영된 좌석은 그대로인데
          // 그 사람만 대기 목록으로 다시 끌려나오는 모순이 생긴다 — 실패로 세지 않는다.
          doneSeatIds.add(seatId);
          continue;
        }
        console.error("confirmAllPendingSeatAssignments:", seatId, err);
        failed.push({ seatId, waiting: pending.waiting, err });
      }
    }
  } finally {
    for (const seatId of doneSeatIds) GL.pendingSeatAssignments.delete(seatId);
    if (entries.length) GL.batchSeatMutationDepth = Math.max(0, (GL.batchSeatMutationDepth || 0) - 1);
  }

  // 개별 assignSelectedWaitingToSeat 호출은 skipOptimistic일 때 화면 갱신(선택 표시 포함)을
  // 건너뛰므로, 배치 전체가 끝난 지금 한 번만 직접 렌더한다 — 안 그러면 "배치확인 (N)"
  // 숫자·좌석은 위 finally에서 한 번에 정리됐는데 화면이 그걸 반영할 계기가 없다.
  if (entries.length && !failed.length) flushOptimisticGlobalLayoutUi();

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
