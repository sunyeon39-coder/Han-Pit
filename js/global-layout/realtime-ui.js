import { GL } from "./state.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { updateGlobalLayoutMetaCounts, updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { renderSeats, renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { renderGlobalLayoutMobile } from "./mobile-panel-render.js";

let flushScheduled = false;
let flushTimer = 0;
const pending = { seats: false, waiting: false, seatPanel: false, metaOnly: false };

/** Firestore 연속 스냅샷을 한 프레임으로 묶어 45명 동시 사용 시 렌더 폭주 완화 */
const REALTIME_UI_DEBOUNCE_MS = 64;

export function bumpGlobalLayoutDataRevision() {
  GL.dataRevision = (GL.dataRevision || 0) + 1;
  GL._waitingListCache = null;
  GL._waitingListCacheRev = -1;
  GL._waitingPanelFp = "";
  GL._seatPanelFp = "";
}

function flushGlobalLayoutRealtimeUi() {
  flushScheduled = false;
  flushTimer = 0;
  const f = { ...pending };
  pending.seats = false;
  pending.waiting = false;
  pending.seatPanel = false;
  pending.metaOnly = false;

  if (layoutIsMobile()) {
    if (f.seats || f.waiting || f.seatPanel || f.metaOnly) {
      renderGlobalLayoutMobile({ sync: true });
    }
    return;
  }

  if (f.seats) renderSeats(GL.globalSeats);
  if (f.seats || f.seatPanel || f.waiting || f.metaOnly) {
    renderSeatPanel();
    renderWaiting();
  }
  if (f.seats || f.seatPanel || f.waiting || f.metaOnly) {
    updateGlobalLayoutMetaCounts(GL.globalSeats);
  }
}

export function scheduleGlobalLayoutRealtimeUi(flags = {}) {
  if (flags.seats) pending.seats = true;
  if (flags.waiting) pending.waiting = true;
  if (flags.seatPanel) pending.seatPanel = true;
  if (flags.metaOnly) pending.metaOnly = true;
  if (flushScheduled) return;
  flushScheduled = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    requestAnimationFrame(flushGlobalLayoutRealtimeUi);
  }, REALTIME_UI_DEBOUNCE_MS);
}
