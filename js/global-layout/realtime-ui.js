import { GL } from "./state.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { renderSeats, renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";

let flushScheduled = false;
const pending = { seats: false, waiting: false, seatPanel: false, metaOnly: false };

export function bumpGlobalLayoutDataRevision() {
  GL.dataRevision = (GL.dataRevision || 0) + 1;
}

export function scheduleGlobalLayoutRealtimeUi(flags = {}) {
  if (flags.seats) pending.seats = true;
  if (flags.waiting) pending.waiting = true;
  if (flags.seatPanel) pending.seatPanel = true;
  if (flags.metaOnly) pending.metaOnly = true;
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const f = { ...pending };
    pending.seats = false;
    pending.waiting = false;
    pending.seatPanel = false;
    pending.metaOnly = false;

    if (f.seats) renderSeats(GL.globalSeats);
    if (f.seatPanel && GL.activeTab === "seat") renderSeatPanel();
    if (f.waiting && GL.activeTab === "wait") {
      renderWaiting(getCurrentTournamentWaiting());
    }
    if (f.metaOnly) updateGlobalLayoutWaitingMeta();
  });
}
