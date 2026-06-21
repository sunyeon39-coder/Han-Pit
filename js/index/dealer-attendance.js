/**
 * index 딜러 출근/배치 — 구현은 dealer-attendance-*.js 로 분리, 이 파일은 호환용 re-export.
 */
export { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
export {
  writeAttendanceLog,
  bindAttendanceLogsRealtime,
  setupAttendanceLogEvents
} from "./dealer-attendance-logs.js";
export {
  setupWorkSummaryEvents,
  handleShowWorkSummaryClick
} from "./dealer-attendance-work-summary-ui.js";
export { computeMyTournamentWorkSummary } from "./dealer-attendance-work-summary.js";
export {
  joinSharedWaitingOnCheckIn,
  removeFromSharedWaitingOnCheckOut
} from "./dealer-attendance-waiting.js";

export { updateMyAttendanceStatus, updateAdminAttendanceStatus } from "./dealer-attendance-status-updates.js";
export { adjustMyCheckedInAt, adjustMyCheckedOutAt } from "./dealer-attendance-adjust-checkin.js";
export { scheduleRenderDealerOps, renderDealerOps, renderDealerOpsPartial, updateDealerAdminList } from "./dealer-attendance-render.js";
export { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
export { ensureMyState } from "./dealer-attendance-ensure-waiting.js";
export { bindDealerAttendanceRealtime, bindDealerSeatRealtime } from "./dealer-attendance-realtime.js";
export { getAdminAttendanceList } from "./dealer-attendance-admin-list.js";
export { forceAdminCheckedOut, forceSelfCheckedOut } from "./dealer-attendance-force-checkout.js";
export { ensureMeRecovered } from "./dealer-attendance-recovery.js";
