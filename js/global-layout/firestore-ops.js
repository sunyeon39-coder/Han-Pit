/**
 * 통합 배치도 Firestore 작업 — 구현은 fs-* 모듈에 분리, 이 파일은 호환용 re-export.
 */
export {
  resolveTournamentEventTitle,
  validateLayoutEventForGlobalOps,
  ensureLayoutEventShellForGlobalOps,
  syncLayoutProjection
} from "./fs-layout-projection.js";
export {
  updateGlobalWaiting,
  undoLastGlobalAction,
  addManualWaiting,
  removeManualWaiting,
  setWaitingBlocked
} from "./fs-waiting-list-undo.js";
export { assignSelectedWaitingToSeat } from "./fs-assign-waiting-to-seat.js";
export { clearSeat } from "./fs-clear-global-seat.js";
export {
  alignSelectedGlobalSeats,
  saveSeatPosition,
  deleteGlobalSeat,
  applyGlobalSeatRename,
  addGlobalSeat
} from "./fs-seat-crud.js";
