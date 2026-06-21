import { IX } from "./state.js";
import { render, patchEventCardsLight, refreshCardStatuses } from "./event-cards-render.js";
import { populateEventSelect, renderEventAdminList } from "./event-cards-admin-form.js";

let flushScheduled = false;
let flushTimer = 0;
let pendingCards = false;
let pendingLight = false;
let pendingAdminForm = false;

const INDEX_REALTIME_UI_DEBOUNCE_MS = 64;

function flushIndexCardsRender() {
  flushScheduled = false;
  flushTimer = 0;
  const doCards = pendingCards;
  const doLight = pendingLight;
  const doAdmin = pendingAdminForm;
  pendingCards = false;
  pendingLight = false;
  pendingAdminForm = false;

  if (doLight && !doCards) {
    if (!patchEventCardsLight()) render();
    refreshCardStatuses();
  } else if (doCards) {
    render();
    refreshCardStatuses();
  }
  if (
    doAdmin &&
    IX.eventCardSelect &&
    IX.eventAdminModal?.classList.contains("show")
  ) {
    const selectedId = IX.eventCardId?.value?.trim() || IX.eventCardSelect.value || "";
    populateEventSelect(selectedId);
    renderEventAdminList();
  }
}

export function scheduleIndexCardsRender(opts = {}) {
  if (opts.adminForm) pendingAdminForm = true;
  if (opts.light) pendingLight = true;
  else pendingCards = true;
  if (flushScheduled) return;
  flushScheduled = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    requestAnimationFrame(flushIndexCardsRender);
  }, INDEX_REALTIME_UI_DEBOUNCE_MS);
}
