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
  if (GL.waitingCountEl) {
    GL.waitingCountEl.textContent = `WAIT: ${waitAssignable}`;
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
