import { isLayoutHealDebugEnabled } from "../shared/app-debug.js";

/**
 * layout.html: 로컬 정합 저장(heal), 되돌리기 스냅샷(undo)
 */
export function createLayoutHealUndo(deps) {
  const {
    ui,
    eventState,
    waitingState,
    clone,
    reconcileLocalState,
    saveEventState,
    saveWaitingState,
    syncCurrentEventUserTruth,
    syncStatusesFromCurrentState,
    canManageLayout,
    onAfterUndo
  } = deps;

  function captureLayoutUndo(label = "") {
    ui.lastUndoAction = {
      label,
      eventState: clone(eventState),
      waitingState: clone(waitingState),
      selectedSeatId: ui.selectedSeatId,
      selectedWaitingId: ui.selectedWaitingId,
      capturedAt: Date.now()
    };
  }

  async function healAndPersistState(reason = "") {
    const { changedEvent, changedWaiting } = reconcileLocalState();

    const saves = [];
    if (changedEvent) {
      eventState.updatedAt = Date.now();
      saves.push(saveEventState());
    }
    if (changedWaiting) {
      waitingState.updatedAt = Date.now();
      saves.push(saveWaitingState());
    }
    if (saves.length) await Promise.all(saves);

    if (changedEvent || changedWaiting) {
      await syncCurrentEventUserTruth();
      if (isLayoutHealDebugEnabled()) {
        console.debug("[healAndPersistState]", reason, { changedEvent, changedWaiting });
      }
    }
  }

  async function undoLastAction() {
    if (!canManageLayout()) return;
    if (!ui.lastUndoAction) return;

    const snap = ui.lastUndoAction;
    eventState.version = snap.eventState.version;
    eventState.eventId = snap.eventState.eventId;
    eventState.boxId = snap.eventState.boxId;
    eventState.nextSeatNo = snap.eventState.nextSeatNo;
    eventState.nextSeatOrder = snap.eventState.nextSeatOrder;
    eventState.seats = Array.isArray(snap.eventState.seats) ? clone(snap.eventState.seats) : [];
    eventState.updatedAt = Date.now();

    waitingState.version = snap.waitingState.version;
    waitingState.waiting = Array.isArray(snap.waitingState.waiting) ? clone(snap.waitingState.waiting) : [];
    waitingState.updatedAt = Date.now();

    ui.selectedSeatId = snap.selectedSeatId || null;
    ui.selectedWaitingId = snap.selectedWaitingId || null;
    ui.lastUndoAction = null;

    await Promise.all([saveEventState(), saveWaitingState()]);
    await syncStatusesFromCurrentState();
    onAfterUndo();
  }

  return { captureLayoutUndo, healAndPersistState, undoLastAction };
}
