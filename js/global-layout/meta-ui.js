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
  // 배치확인 눌러서 스테이징만 되고 아직 실제 저장 전인 인원은 대기 카운트 계산에서
  // 빠지는데(좌석 박스엔 이미 흰색으로 얹혀 있음), 그 사이엔 "대기 0인데 화면엔 사람이
  // 있네?"로 헷갈린다 — 확정되면 결국 맞는 숫자로 정리되니, 그 사이엔 misleading한 0
  // 대신 스테이징 인원수를 보여준다(이미 waitAssignable에 포함돼 있을 수도 있어 더하지
  // 않고 둘 중 큰 값을 쓴다 — 중복 카운트 방지).
  const pendingCount = GL.pendingSeatAssignments?.size || 0;
  if (GL.waitingCountEl) {
    GL.waitingCountEl.textContent = `WAIT: ${Math.max(waitAssignable, pendingCount)}`;
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
