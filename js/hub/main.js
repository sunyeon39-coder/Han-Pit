import { auth, db } from "../firebase.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { logout } from "../auth.js";

import { normalizeUserProfile } from "../shared/auth-helpers.js";
import { ensureUserDoc, scheduleBackgroundUserProfileSync } from "../login/user-sync.js";
import {
  readLoginProfileCache,
  isLoginProfileCacheFresh,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";
import { getIsAdminUser } from "./hub-helpers.js";
import { closeModal, openModal } from "../shared/dom-utils.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { ensureDocumentShellBackground } from "../shared/page-boot-shell.js";

import { initHubRefs, hubRefs } from "./hub-dom-refs.js";
import { showHubListLoading } from "./hub-tournament-list.js";
import { FALLBACK_TOURNAMENTS, hubState } from "./hub-state.js";
import { sortTournaments } from "./hub-helpers.js";
import {
  populateTournamentSelect,
  renderAdminUserList,
  syncSelectedTournamentForm,
  resetTournamentForm,
  renderUserManageModal,
  closeUserManageModal,
  runAdminAction,
  clearAdminBulkSelection,
  applyAdminBulkSelectAll,
  syncAdminBulkSelectAllCheckbox
} from "./hub-admin-ui.js";
import {
  bindHubForegroundAccessResync,
  bindHubPeriodicAccessResync,
  bindMyProfileRealtime,
  bindTournamentsRealtime,
  bindUsersRealtime,
  clearHubProfileCacheResyncDebounce,
  disposeHubForegroundAccessResync,
  disposeHubPeriodicAccessResync,
  loadAllUsers,
  loadTournaments,
  loadUserProfile,
  resyncHubAccessFromServer,
  healNonAdminUsersToBasic,
  prefetchHubTournamentsCache,
  seedHubTournamentsFromSessionCache
} from "./hub-loaders-realtime.js";
import { scheduleHubTournamentsRender } from "./hub-realtime-ui.js";
import { saveNickname } from "./hub-profile.js";
import {
  assignEventCodeToUser,
  bulkAssignEventCodesToUsers,
  bulkRemoveUserCodes,
  deleteTournamentCurrent,
  grantEventDirectly,
  removeUserCode,
  revokeEventDirectly,
  saveTournament,
  showUserCode
} from "./hub-admin-firestore.js";
import { wireHanSupportHub } from "./hub-han-support.js";
import {
  alertFcmRegistrationResult,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  refreshFcmTokenIfGranted,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";

initHubRefs();
ensureDocumentShellBackground();
hubState.tournamentsBootstrapping = true;
hubState.tournamentsListReady = false;
if (seedHubTournamentsFromSessionCache()) {
  scheduleHubTournamentsRender();
} else {
  showHubListLoading();
}
void prefetchHubTournamentsCache();

const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
void ensureForegroundFcmBadgeListener();

const disposeHanSupportHub = wireHanSupportHub({ hubRefs, hubState });

function bindHubPushUiOnce() {
  const btn = hubRefs.hubEnablePushBtn;
  if (!btn || btn.dataset.hubPushBound === "1") return;
  btn.dataset.hubPushBound = "1";
  btn.addEventListener("click", async () => {
    const u = hubState.currentUser ?? auth.currentUser;
    if (!u?.uid) {
      alert("로그인을 확인하는 중입니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    const r = await registerFcmWebPushAndSave(u.uid);
    alertFcmRegistrationResult(r);
    syncPushOfferButton(btn, u.uid);
  });
}

bindHubPushUiOnce();

const {
  logoutBtn,
  profileBtn,
  adminBtn,
  profileModal,
  closeProfileBtn,
  saveProfileBtn,
  adminModal,
  closeAdminBtn,
  newTournamentBtn,
  saveTournamentBtn,
  deleteTournamentBtn,
  adminEventSelect,
  adminSearchInput,
  adminBulkSelectAll,
  adminBulkAssignCodeBtn,
  adminBulkRemoveCodeBtn,
  adminResetBasicRolesBtn,
  adminUserList,
  closeUserManageBtn,
  closeUserManageFooterBtn,
  manageAllowBtn,
  manageRevokeBtn,
  manageAssignCodeBtn,
  manageRemoveCodeBtn,
  manageViewCodeBtn,
  userManageModal
} = hubRefs;

logoutBtn?.addEventListener("click", async () => {
  try {
    await logout();
  } catch (err) {
    console.error(err);
    alert("로그아웃에 실패했습니다.");
  }
});

profileBtn?.addEventListener("click", () => {
  if (!hubState.currentUser || !hubState.currentUserProfile) return;

  hubRefs.profileEmail.value = hubState.currentUser.email || "";
  hubRefs.profileNickname.value = hubState.currentUserProfile.nickname || "";
  hubRefs.profileAccessCode.value = hubState.currentUserProfile.accessCode || "";
  openModal(hubRefs.profileModal);
});

adminBtn?.addEventListener("click", () => {
  const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);

  if (!isAdmin) return;

  clearAdminBulkSelection();
  populateTournamentSelect();
  renderAdminUserList();
  openModal(adminModal);

  void Promise.all([
    hubState.tournamentsCache.length ? Promise.resolve() : loadTournaments(),
    hubState.usersCache.length ? Promise.resolve() : loadAllUsers()
  ]).then(() => {
    populateTournamentSelect();
    renderAdminUserList();
  });
});

closeProfileBtn?.addEventListener("click", () => closeModal(profileModal));
saveProfileBtn?.addEventListener("click", saveNickname);

closeAdminBtn?.addEventListener("click", () => {
  clearAdminBulkSelection();
  closeModal(adminModal);
});

newTournamentBtn?.addEventListener("click", () => {
  resetTournamentForm();
  hubRefs.adminTournamentId.focus();
});

saveTournamentBtn?.addEventListener("click", () => {
  void runAdminAction(saveTournament);
});
deleteTournamentBtn?.addEventListener("click", () => {
  void runAdminAction(deleteTournamentCurrent);
});

adminEventSelect?.addEventListener("change", () => {
  syncSelectedTournamentForm();
  clearAdminBulkSelection();
  renderAdminUserList();

  if (hubState.selectedManageUid) {
    renderUserManageModal(hubState.selectedManageUid);
  }
});

adminSearchInput?.addEventListener("input", renderAdminUserList);

adminUserList?.addEventListener("change", (e) => {
  const cb = e.target.closest(".admin-user-cb");
  if (!cb) return;
  const uid = String(cb.dataset.uid || "").trim();
  if (!uid) return;
  if (cb.checked) hubState.adminBulkSelectedUids.add(uid);
  else hubState.adminBulkSelectedUids.delete(uid);
  syncAdminBulkSelectAllCheckbox();
});

adminUserList?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const uid = btn.dataset.uid;

  if (action === "openManage" && uid) {
    renderUserManageModal(uid);
  }
});

adminBulkSelectAll?.addEventListener("change", () => {
  applyAdminBulkSelectAll(!!adminBulkSelectAll?.checked);
});

adminBulkAssignCodeBtn?.addEventListener("click", async () => {
  const uids = [...hubState.adminBulkSelectedUids];
  const eventId = hubRefs.adminEventSelect?.value || "";
  await runAdminAction(async () => {
    await bulkAssignEventCodesToUsers(uids, eventId);
  });
});

adminBulkRemoveCodeBtn?.addEventListener("click", async () => {
  const uids = [...hubState.adminBulkSelectedUids];
  await runAdminAction(async () => {
    await bulkRemoveUserCodes(uids);
  });
});

adminResetBasicRolesBtn?.addEventListener("click", async () => {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
  const ok = window.confirm(
    "시스템 admin(sunyeon9501@gmail.com)을 제외한 모든 유저의 role을 user로, 직접 허용(allowedEvents)을 비웁니다.\n운영 권한이 필요한 유저는 이후「직접 허용」으로 다시 부여해야 합니다.\n계속할까요?"
  );
  if (!ok) return;
  await runAdminAction(async () => {
    hubState.usersRoleHealDone = false;
    const { fixed } = await healNonAdminUsersToBasic(hubState.usersCache, {
      stripAllowedEvents: true
    });
    hubState.usersRoleHealDone = true;
    renderAdminUserList();
    alert(fixed > 0 ? `${fixed}명을 기본 user로 정리했습니다.` : "정리할 유저가 없습니다.");
  });
});

hubRefs.profileModal?.addEventListener("click", (e) => {
  if (e.target === hubRefs.profileModal) closeModal(hubRefs.profileModal);
});

adminModal?.addEventListener("click", (e) => {
  if (e.target === adminModal) {
    clearAdminBulkSelection();
    closeModal(adminModal);
  }
});

closeUserManageBtn?.addEventListener("click", closeUserManageModal);
closeUserManageFooterBtn?.addEventListener("click", closeUserManageModal);

manageAllowBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = hubRefs.adminEventSelect?.value || "";
    if (!hubState.selectedManageUid || !eventId) return;
    await grantEventDirectly(hubState.selectedManageUid, eventId);
    renderUserManageModal(hubState.selectedManageUid);
  });
});

manageRevokeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = hubRefs.adminEventSelect?.value || "";
    if (!hubState.selectedManageUid || !eventId) return;
    await revokeEventDirectly(hubState.selectedManageUid, eventId);
    renderUserManageModal(hubState.selectedManageUid);
  });
});

manageAssignCodeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = hubRefs.adminEventSelect?.value || "";
    if (!hubState.selectedManageUid || !eventId) return;
    await assignEventCodeToUser(hubState.selectedManageUid, eventId);
    renderUserManageModal(hubState.selectedManageUid);
  });
});

manageRemoveCodeBtn?.addEventListener("click", async () => {
  if (!hubState.selectedManageUid) return;

  const ok = confirm("이 유저의 코드를 제거할까요?");
  if (!ok) return;

  await runAdminAction(async () => {
    await removeUserCode(hubState.selectedManageUid);
    renderUserManageModal(hubState.selectedManageUid);
  });
});

manageViewCodeBtn?.addEventListener("click", () => {
  if (!hubState.selectedManageUid) return;
  showUserCode(hubState.selectedManageUid);
});

userManageModal?.addEventListener("click", (e) => {
  if (e.target === userManageModal) closeUserManageModal();
});

function paintHubTournamentList() {
  scheduleHubTournamentsRender();
}

function disposeHubSessionWatches() {
  hubState.hubProfileWatchUid = null;
  clearHubProfileCacheResyncDebounce();
  disposeHubPeriodicAccessResync();
  if (hubState.stopMyProfileWatch) {
    hubState.stopMyProfileWatch();
    hubState.stopMyProfileWatch = null;
  }
  if (hubState.stopTournamentsWatch) {
    hubState.stopTournamentsWatch();
    hubState.stopTournamentsWatch = null;
  }
  if (hubState.stopUsersWatch) {
    hubState.stopUsersWatch();
    hubState.stopUsersWatch = null;
  }
  disposeHubForegroundAccessResync();
}

async function bootstrapHubSession(user) {
  const flow = ++hubState.hubAuthFlowGen;
  let bootTimeoutId = 0;
  hubState.tournamentsBootstrapping = true;
  if (!hubState.tournamentsCache.length) {
    showHubListLoading();
  }

  const cachedProfile =
    isLoginProfileCacheFresh(user.uid) ? readLoginProfileCache(user.uid) : null;
  if (cachedProfile) {
    hubState.currentUserProfile = normalizeUserProfile(cachedProfile, user.email || "");
    writeLoginProfileCache(user.uid, hubState.currentUserProfile);
    if (hubState.tournamentsCache.length > 0) {
      paintHubTournamentList();
    }
  }

  try {
  bootTimeoutId = window.setTimeout(() => {
    if (flow !== hubState.hubAuthFlowGen) return;
    if (!hubRefs.eventListEl?.classList.contains("event-list--loading")) return;
    console.warn("[hub] bootstrap timeout — showing fallback tournaments");
    if (!hubState.tournamentsCache.length) {
      hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
    }
    hubState.tournamentsListReady = true;
    hubState.tournamentsBootstrapping = false;
    paintHubTournamentList();
  }, 8000);

  let [profile] = await Promise.all([
    loadUserProfile(user.uid, user.email || ""),
    loadTournaments()
  ]);
  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  if (!profile) {
    const ensured = await ensureUserDoc(user);
    if (ensured?.profile) {
      profile = normalizeUserProfile(ensured.profile, user.email || "");
    } else {
      profile = await loadUserProfile(user.uid, user.email || "");
    }
  }

  if (!profile) {
    profile = normalizeUserProfile(
      {
        email: user.email || "",
        nickname: user.displayName || "",
        accessCode: "",
        allowedEvents: {}
      },
      user.email || ""
    );
    void ensureUserDoc(user).catch((err) => {
      console.warn("ensureUserDoc (background):", err);
    });
  }

  hubState.currentUserProfile = profile;
  writeLoginProfileCache(user.uid, profile);
  paintHubTournamentList();
  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  scheduleBackgroundUserProfileSync(user);

  bindTournamentsRealtime();
  bindMyProfileRealtime(user.uid);

  void resyncHubAccessFromServer(user.uid)
    .then(() => {
      if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;
      paintHubTournamentList();
    })
    .catch((err) => {
      console.warn("resyncHubAccessFromServer:", err);
    });

  if (isAppDebugEnabled()) {
    console.debug("[HUB AUTH]", {
      uid: user.uid,
      email: user.email || "",
      profile: hubState.currentUserProfile,
      isAdmin: hubState.currentUserProfile?.role === "admin"
    });
  }

  const isAdmin = getIsAdminUser(user, hubState.currentUserProfile);
  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  if (isAdmin) {
    adminBtn?.classList.remove("hidden");
    bindUsersRealtime();
    void loadAllUsers()
      .then(() => {
        if (flow !== hubState.hubAuthFlowGen) return;
        if (hubRefs.adminModal?.classList.contains("show")) renderAdminUserList();
      })
      .catch((err) => {
        console.warn("loadAllUsers:", err);
      });
  } else {
    adminBtn?.classList.add("hidden");
  }

  syncPushOfferButton(hubRefs.hubEnablePushBtn, user.uid);
  void refreshFcmTokenIfGranted(user.uid);
  flushAppBadgeIfVisible();

  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;
  bindHubForegroundAccessResync(user.uid);

  if (!isAdmin) {
    bindHubPeriodicAccessResync(user.uid);
  } else {
    disposeHubPeriodicAccessResync();
  }

  window.setTimeout(() => {
    if (flow !== hubState.hubAuthFlowGen) return;
    if (hubState.currentUser?.uid !== user.uid) return;
    void resyncHubAccessFromServer(user.uid);
  }, 450);
  } finally {
    if (bootTimeoutId) clearTimeout(bootTimeoutId);
    hubState.tournamentsBootstrapping = false;
    if (!hubState.tournamentsListReady) hubState.tournamentsListReady = true;
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    hubState.hubAuthFlowGen = 0;
    hubState.currentUser = null;
    hubState.currentUserProfile = null;
    disposeHubSessionWatches();
    location.replace("./login.html");
    return;
  }

  hubState.currentUser = user;
  if (!hubState.tournamentsCache.length) {
    showHubListLoading();
  }

  const run = bootstrapHubSession(user)
    .catch((err) => {
      console.error("hub auth init error:", err);
      hubState.tournamentsBootstrapping = false;
      hubState.tournamentsListReady = true;
      if (!hubState.tournamentsCache.length) {
        hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
      }
      paintHubTournamentList();
      alert("허브 데이터를 불러오지 못했습니다.");
    })
    .finally(() => {
      hubState.tournamentsBootstrapping = false;
      if (!hubState.tournamentsListReady) hubState.tournamentsListReady = true;
      if (hubState.currentUser?.uid === user.uid) {
        paintHubTournamentList();
      }
    });

  void run;
});

window.addEventListener("beforeunload", () => {
  if (hubState.stopTournamentsWatch) hubState.stopTournamentsWatch();
  if (hubState.stopUsersWatch) hubState.stopUsersWatch();
  if (hubState.stopMyProfileWatch) hubState.stopMyProfileWatch();
  hubState.hubProfileWatchUid = null;
  clearHubProfileCacheResyncDebounce();
  disposeHubPeriodicAccessResync();
  disposeHubForegroundAccessResync();
  disposeHanSupportHub();
});
