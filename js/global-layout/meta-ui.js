import { GL } from "./state.js";
import { isEmptyPerson } from "./utils.js";
import { countTournamentWaitingQueue } from "../shared/tournament-waiting-queue.js";
import { getCurrentTournamentWaiting, isWaitingBlocked } from "./waiting.js";

export function updateGlobalLayoutWaitingMeta() {
  const waiting = getCurrentTournamentWaiting();
  const blocked = waiting.filter((w) => isWaitingBlocked(w)).length;
  const waitAssignable = countTournamentWaitingQueue({
    globalWaiting: GL.globalWaiting,
    tournamentId: GL.tournamentId,
    attendanceInactiveUids: GL.attendanceInactiveUids,
    globalSeats: GL.globalSeats,
    attendanceFilterReady: GL.attendanceFilterReady === true,
    attendanceWaitingRows: GL.attendanceWaiting,
    excludeBlocked: true
  });
  // "확정 대기 중"인 인원은 대기 카운트에 안 잡힌다 — 이유가 두 가지다:
  // (1) 배치확인만 누르고 아직 실제 저장 전(스테이징) 인원 — GL.pendingSeatAssignments.
  // (2) 스왑이 실제로 저장은 됐지만 아직 finalize(0~10분) 전이라 밀려나는 기존
  //     점유자가 아직 대기로 안 돌아온 상태 — seat.incomingPerson.
  // 둘 다 좌석엔 이미 흰색으로 반영돼 있어서 "대기 0인데 화면엔 사람이 있네?"로 헷갈린다
  // — 확정/finalize되면 결국 맞는 숫자로 정리되니, 그 사이엔 misleading한 0 대신 이
  // "아직 최종 정리 전" 인원수를 보여준다. 스테이징과 incomingPerson은 서로 배타적인
  // 상태(확정되는 순간 스테이징에서 빠지고 incomingPerson으로 넘어감)라 더해도 중복
  // 집계가 안 되고, waitAssignable과는 겹칠 수 있어 둘 중 큰 값을 쓴다.
  const pendingCount = GL.pendingSeatAssignments?.size || 0;
  const incomingCount = (GL.globalSeats || []).filter(
    (s) => !isEmptyPerson(String(s?.incomingPerson || "").trim())
  ).length;
  if (GL.waitingCountEl) {
    GL.waitingCountEl.textContent = `WAIT: ${Math.max(waitAssignable, pendingCount + incomingCount)}`;
  }
  if (GL.blockedCountEl) {
    GL.blockedCountEl.textContent = `BLOCK: ${blocked}`;
  }
}

export function updateGlobalLayoutMetaCounts(seats = []) {
  const list = Array.isArray(seats) ? seats : [];
  if (GL.seatCountEl) GL.seatCountEl.textContent = `SEAT: ${list.length}`;
  if (GL.assignedCountEl) {
    const assignedCount = list.filter((s) => !isEmptyPerson(String(s?.person || "").trim())).length;
    GL.assignedCountEl.textContent = `ASSIGNED: ${assignedCount}`;
  }
  updateGlobalLayoutWaitingMeta();
}

export function syncGlobalLayoutMetaPills(root) {
  if (!root) return;
  const map = {
    seat: GL.seatCountEl?.textContent || "SEAT: 0",
    assigned: GL.assignedCountEl?.textContent || "ASSIGNED: 0",
    wait: GL.waitingCountEl?.textContent || "WAIT: 0",
    block: GL.blockedCountEl?.textContent || "BLOCK: 0"
  };
  root.querySelectorAll(".global-mobile-meta [data-meta]").forEach((el) => {
    const key = String(el.dataset.meta || "").trim();
    if (map[key]) el.textContent = map[key];
  });
}
