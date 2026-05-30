import { hubState } from "./hub-state.js";
import { renderTournaments } from "./hub-tournament-list.js";
import { renderAdminUserList } from "./hub-admin-ui.js";
import { getIsAdminUser } from "./hub-helpers.js";

let flushScheduled = false;
let adminFlushScheduled = false;

export function scheduleHubTournamentsRender() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    renderTournaments(
      hubState.tournamentsCache,
      hubState.currentUserProfile,
      hubState.currentUser
    );
  });
}

export function scheduleHubAdminRender() {
  if (adminFlushScheduled) return;
  adminFlushScheduled = true;
  requestAnimationFrame(() => {
    adminFlushScheduled = false;
    if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
    renderAdminUserList();
  });
}
