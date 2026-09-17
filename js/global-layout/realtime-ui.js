import { GL } from "./state.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { updateGlobalLayoutMetaCounts, updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { renderSeats, renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { renderGlobalLayoutMobile } from "./mobile-panel-render.js";

let flushScheduled = false;
let flushTimer = 0;
let firstPendingAt = 0;
const pending = { seats: false, waiting: false, seatPanel: false, metaOnly: false };

/** Firestore 연속 스냅샷을 한 프레임으로 묶어 45명 동시 사용 시 렌더 폭주 완화 */
const REALTIME_UI_DEBOUNCE_MS = 96;
/**
 * 배치확인(confirmAllPendingSeatAssignments)은 좌석마다 순차적으로 트랜잭션을 커밋한다.
 * 그 화면(직접 누른 admin)은 GL.batchSeatMutationDepth로 스냅샷 반영 자체를 배치가 끝날
 * 때까지 미뤄두지만, 그건 그 브라우저만의 로컬 상태라 "지켜보고만 있는" 다른 화면(다른
 * admin 세션, 근무자 화면 등)은 그 사실을 모른 채 커밋될 때마다 좌석 하나씩 스냅샷을
 * 그대로 받아, 좌석이 한 번에 하나씩 뚝뚝 바뀌는 것처럼 보였다. 아래 sliding debounce로
 * 새 스냅샷이 계속 도착하는 동안은 렌더를 계속 미뤄(마지막 한 번만 도착 후 96ms 뒤 렌더)
 * 배치 전체가 한 번에 반영된 것처럼 보이게 한다. MAX_WAIT는 스냅샷이 끊이지 않고 계속
 * 도착하는 극단적 상황에서도 화면이 너무 오래 멈춰 보이지 않게 하는 안전판이다.
 */
const REALTIME_UI_MAX_WAIT_MS = 2000;

export function bumpGlobalLayoutDataRevision() {
  GL.dataRevision = (GL.dataRevision || 0) + 1;
  GL._waitingListCache = null;
  GL._waitingListCacheRev = -1;
}

function flushGlobalLayoutRealtimeUi() {
  flushScheduled = false;
  flushTimer = 0;
  firstPendingAt = 0;
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

  const now = Date.now();
  if (!flushScheduled) {
    flushScheduled = true;
    firstPendingAt = now;
  }
  if (flushTimer) clearTimeout(flushTimer);
  const elapsedSinceFirst = now - firstPendingAt;
  const wait = Math.min(REALTIME_UI_DEBOUNCE_MS, Math.max(0, REALTIME_UI_MAX_WAIT_MS - elapsedSinceFirst));
  flushTimer = window.setTimeout(() => {
    requestAnimationFrame(flushGlobalLayoutRealtimeUi);
  }, wait);
}
