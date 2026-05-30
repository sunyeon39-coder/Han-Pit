import { isDirectOpsAdmin } from "../shared/tournament-ops-access.js";
import { getIsAdminUser } from "./hub-helpers.js";
import { hubRefs, initHubRefs } from "./hub-dom-refs.js";
import { hubState } from "./hub-state.js";

/** 직접 허용 admin — 허브 UI 표시 (Access Manage 는 시스템 admin 전용) */
export function applyHubOpsChrome(user = hubState.currentUser) {
  if (!hubRefs.eventListEl) initHubRefs();

  const profile = hubState.currentUserProfile;
  const { adminBtn, profileBtn } = hubRefs;
  const system = getIsAdminUser(user, profile);
  const ops = isDirectOpsAdmin(user?.email || profile?.email, profile);

  if (system) adminBtn?.classList.remove("hidden");
  else adminBtn?.classList.add("hidden");

  profileBtn?.classList.toggle("top-btn--ops-admin", ops);
  if (profileBtn) {
    profileBtn.title = ops ? "운영 admin (직접 허용)" : "";
  }
  try {
    document.documentElement.dataset.hanpitOpsAdmin = ops ? "1" : "0";
  } catch {
    /* ignore */
  }
}
