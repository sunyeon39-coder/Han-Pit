let flushScheduled = false;
const pending = { canvas: false, panel: false, timers: false };
let healReasons = [];
let healDebounceTimer = null;

export function createLayoutRealtimeUi(deps) {
  const { render, renderPanel, layoutTimers, layoutHealUndo } = deps;

  function scheduleLayoutRealtimeUi(flags = {}) {
    if (flags.canvas) pending.canvas = true;
    if (flags.panel) pending.panel = true;
    if (flags.timers) pending.timers = true;
    if (flags.heal && String(flags.heal).trim()) healReasons.push(String(flags.heal));
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      const doCanvas = pending.canvas;
      const doPanel = pending.panel;
      const doTimers = pending.timers;
      const heals = healReasons.splice(0);
      pending.canvas = false;
      pending.panel = false;
      pending.timers = false;

      if (doCanvas) {
        if (!render.renderCanvasOnly?.()) render();
      }
      if (doPanel) renderPanel();
      if (doTimers) layoutTimers.updateTimers();

      if (heals.length) {
        const reason = heals[heals.length - 1];
        if (healDebounceTimer) clearTimeout(healDebounceTimer);
        healDebounceTimer = setTimeout(() => {
          healDebounceTimer = null;
          void layoutHealUndo.healAndPersistState(reason);
        }, 400);
      }
    });
  }

  return { scheduleLayoutRealtimeUi };
}
