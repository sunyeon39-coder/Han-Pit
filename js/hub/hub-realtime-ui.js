import { hubState } from "./hub-state.js";
import { renderTournaments } from "./hub-tournament-list.js";
import { renderAdminUserList } from "./hub-admin-ui.js";
import { getIsAdminUser } from "./hub-helpers.js";

let flushScheduled = false;
let flushTimer = 0;
let adminFlushScheduled = false;
let adminFlushTimer = 0;

const HUB_REALTIME_UI_DEBOUNCE_MS = 64;

export function scheduleHubTournamentsRender() {
  if (flushScheduled) return;
  flushScheduled = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushScheduled = false;
    flushTimer = 0;
    renderTournaments(
      hubState.tournamentsCache,
      hubState.currentUserProfile,
      hubState.currentUser
    );
  }, HUB_REALTIME_UI_DEBOUNCE_MS);
}

export function scheduleHubAdminRender() {
  if (adminFlushScheduled) return;
  adminFlushScheduled = true;
  if (adminFlushTimer) clearTimeout(adminFlushTimer);
  adminFlushTimer = window.setTimeout(() => {
    adminFlushScheduled = false;
    adminFlushTimer = 0;
    if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
    renderAdminUserList();
  }, HUB_REALTIME_UI_DEBOUNCE_MS);
}
