import { GL } from "./state.js";
import { isEmptyPerson } from "./utils.js";
import { getCurrentTournamentWaiting, isWaitingBlocked } from "./waiting.js";

export function updateGlobalLayoutWaitingMeta() {
  // WAIT는 대기 패널에 실제로 보이는 목록(BLOCK 제외)과 같은 소스로 센다 — 예전엔
  // countTournamentWaitingQueue를 따로 돌렸는데, 퇴근자(attendanceCheckedOutUids) 필터와
  // 중복 행 BLOCK 병합(blockIndex)이 빠져 있어 목록보다 숫자가 크게 나왔다.
  const waiting = getCurrentTournamentWaiting();
  const blocked = waiting.filter((w) => isWaitingBlocked(w)).length;
  const waitVisible = waiting.length - blocked;
  // "확정 대기 중" 인원은 목록엔 아직 없다:
  // (1) 배치확인만 누르고 아직 실제 저장 전(스테이징) — GL.pendingSeatAssignments.
  // (2) 스왑 저장 후 finalize(0~10분) 전이라 밀려날 기존 점유자 — seat.incomingPerson.
  // 예전엔 max(목록, 이 인원)로 WAIT 자체를 덮어써서 목록과 숫자가 어긋났다 — 이제
  // WAIT 숫자는 목록과 항상 일치시키고, 이 인원은 괄호로 따로 보여준다.
  const pendingCount = GL.pendingSeatAssignments?.size || 0;
  const incomingCount = (GL.globalSeats || []).filter(
    (s) => !isEmptyPerson(String(s?.incomingPerson || "").trim())
  ).length;
  const transitCount = pendingCount + incomingCount;
  if (GL.waitingCountEl) {
    GL.waitingCountEl.textContent = transitCount
      ? `WAIT: ${waitVisible} (+${transitCount})`
      : `WAIT: ${waitVisible}`;
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
