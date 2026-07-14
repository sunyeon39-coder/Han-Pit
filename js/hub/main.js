import { auth, db } from "../firebase.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { logout } from "../auth.js";

import { normalizeUserProfile } from "../shared/auth-helpers.js";
import { ensureUserDoc, scheduleBackgroundUserProfileSync } from "../login/user-sync.js";
import {
  readLoginProfileCache,
  isLoginProfileCacheFresh,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";
import { getIsAdminUser } from "./hub-helpers.js";
import { isSystemAdminEmail } from "../shared/auth-helpers.js";
import { closeModal, openModal } from "../shared/dom-utils.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { ensureDocumentShellBackground, instantDismissAllBootLoaders, markPageBootLoaded } from "../shared/page-boot-shell.js";
import { isSameAuthSession } from "../shared/auth-session-guard.js";
import { armFirestoreStallWatchdog, showFirestoreStallBanner } from "../shared/firestore-stall-recovery.js";

import { initHubRefs, hubRefs } from "./hub-dom-refs.js";
import { hubState } from "./hub-state.js";
import { sortTournaments } from "./hub-helpers.js";
import { applyHubOpsChrome } from "./hub-ops-chrome.js";
import {
  populateTournamentSelect,
  renderAdminUserList,
  syncSelectedTournamentForm,
  resetTournamentForm,
  renderUserManageModal,
  closeUserManageModal,
  runAdminAction,
  releaseStuckHubAdminAction,
  requireAdminManageContext,
  clearAdminBulkSelection,
  applyAdminBulkSelectAll,
  syncAdminBulkSelectAllCheckbox
} from "./hub-admin-ui.js";
import { loadUserProfileFresh, loadUserProfileRevalidated, raceFirestoreTimeout } from "../shared/load-user-profile.js";
import {
  bindHubForegroundAccessResync,
  bindHubPeriodicAccessResync,
  bindMyProfileRealtime,
  bindTournamentsRealtime,
  bindUsersRealtime,
  disposeUsersRealtime,
  clearHubProfileCacheResyncDebounce,
  disposeHubForegroundAccessResync,
  disposeHubPeriodicAccessResync,
  loadAllUsers,
  loadTournaments,
  loadUserProfile,
  resyncHubAccessFromServer,
  healNonAdminUsersToBasic,
  seedHubTournamentsFromSessionCache,
  seedHubUsersFromSessionCache,
  prefetchHubUsersCache,
  refreshHubUsersFromServer
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
  bootstrapAppPush,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import {
  bindGlobalSeatNotificationWatch,
  disposeGlobalSeatNotificationWatch,
  wireGlobalSeatNotificationVisibilityResync
} from "../shared/global-seat-notification-watch.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";

initHubRefs();
ensureDocumentShellBackground();
instantDismissAllBootLoaders();
markPageBootLoaded(hubRefs.eventListEl);

const hubSeededFromSession = seedHubTournamentsFromSessionCache();
seedHubUsersFromSessionCache();
hubState.tournamentsListReady = hubSeededFromSession;
hubState.tournamentsBootstrapping = !hubSeededFromSession;
if (hubSeededFromSession) scheduleHubTournamentsRender();

let hubSessionUid = "";
let disposeGlobalSeatNotifyVisibility = null;

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
  const user = hubState.currentUser ?? auth.currentUser;
  if (!user) {
    alert("로그인을 확인하는 중입니다. 잠시 후 다시 시도해 주세요.");
    return;
  }

  const profile =
    hubState.currentUserProfile ||
    readLoginProfileCache(user.uid) ||
    normalizeUserProfile({ email: user.email || "" }, user.email || "");
  hubState.currentUserProfile = profile;

  if (hubRefs.profileEmail) hubRefs.profileEmail.value = user.email || "";
  if (hubRefs.profileNickname) hubRefs.profileNickname.value = profile.nickname || "";
  if (hubRefs.profileAccessCode) hubRefs.profileAccessCode.value = profile.accessCode || "";
  openModal(hubRefs.profileModal);
});

adminBtn?.addEventListener("click", () => {
  releaseStuckHubAdminAction();
  const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);

  if (!isAdmin) {
    alert("Access Manage는 시스템 admin 계정만 사용할 수 있습니다.");
    return;
  }

  if (adminSearchInput) adminSearchInput.value = "";
  clearAdminBulkSelection();
  seedHubUsersFromSessionCache();
  openModal(adminModal);
  populateTournamentSelect();
  bindUsersRealtime();
  renderAdminUserList();

  void Promise.all([
    hubState.tournamentsCache.length ? Promise.resolve() : loadTournaments(),
    hubState.usersCache.length
      ? prefetchHubUsersCache()
      : loadAllUsers({ forceServer: false })
  ]).then(() => {
    populateTournamentSelect();
    renderAdminUserList();
  });

  void refreshHubUsersFromServer();

  // 캐시 멈춤(hang)으로 유저 목록이 영영 안 뜨면 복구 배너 안내
  armFirestoreStallWatchdog({
    timeoutMs: 12000,
    dataReady: () => hubState.usersCache.length > 0 || hubState.usersLoading === false,
    onStall: () =>
      showFirestoreStallBanner(
        "유저 목록을 불러오지 못했습니다(연결 지연). 연결 새로고침을 눌러 주세요."
      )
  });
});

closeProfileBtn?.addEventListener("click", () => closeModal(profileModal));
saveProfileBtn?.addEventListener("click", saveNickname);

closeAdminBtn?.addEventListener("click", () => {
  clearAdminBulkSelection();
  disposeUsersRealtime();
  closeModal(adminModal);
});

newTournamentBtn?.addEventListener("click", () => {
  resetTournamentForm();
  hubRefs.adminTournamentId?.focus();
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
  const eventId = String(hubRefs.adminEventSelect?.value || "").trim();
  if (!eventId) {
    alert("대회를 먼저 선택해 주세요.");
    return;
  }
  const uids = [...hubState.adminBulkSelectedUids];
  if (!uids.length) {
    alert("먼저 유저를 선택해 주세요.");
    return;
  }
  await runAdminAction(async () => {
    await bulkAssignEventCodesToUsers(uids, eventId);
  });
});

adminBulkRemoveCodeBtn?.addEventListener("click", async () => {
  const uids = [...hubState.adminBulkSelectedUids];
  if (!uids.length) {
    alert("먼저 유저를 선택해 주세요.");
    return;
  }
  await runAdminAction(async () => {
    await bulkRemoveUserCodes(uids);
  });
});

adminResetBasicRolesBtn?.addEventListener("click", async () => {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
    alert("역할 정리는 시스템 admin 계정만 가능합니다.");
    return;
  }
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
    disposeUsersRealtime();
    closeModal(adminModal);
  }
});

closeUserManageBtn?.addEventListener("click", closeUserManageModal);
closeUserManageFooterBtn?.addEventListener("click", closeUserManageModal);

manageAllowBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const ctx = requireAdminManageContext();
    if (!ctx) return;
    await grantEventDirectly(ctx.uid, ctx.eventId);
    renderUserManageModal(ctx.uid);
  });
});

manageRevokeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const ctx = requireAdminManageContext();
    if (!ctx) return;
    await revokeEventDirectly(ctx.uid, ctx.eventId);
    renderUserManageModal(ctx.uid);
  });
});

manageAssignCodeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const ctx = requireAdminManageContext();
    if (!ctx) return;
    await assignEventCodeToUser(ctx.uid, ctx.eventId);
    renderUserManageModal(ctx.uid);
  });
});

manageRemoveCodeBtn?.addEventListener("click", async () => {
  const ctx = requireAdminManageContext();
  if (!ctx) return;

  const ok = confirm("이 유저의 코드를 제거할까요?");
  if (!ok) return;

  await runAdminAction(async () => {
    await removeUserCode(ctx.uid);
    renderUserManageModal(ctx.uid);
  });
});

manageViewCodeBtn?.addEventListener("click", () => {
  const ctx = requireAdminManageContext({ requireEvent: false });
  if (!ctx) return;
  showUserCode(ctx.uid);
});

userManageModal?.addEventListener("click", (e) => {
  if (e.target === userManageModal) closeUserManageModal();
});

function ensureHubSessionContinuity(user) {
  applyHubOpsChrome(user);
  paintHubTournamentList();

  if (!hubState.currentUserProfile) {
    const cached = readLoginProfileCache(user.uid);
    if (cached) {
      hubState.currentUserProfile = cached;
      applyHubOpsChrome(user);
      paintHubTournamentList();
    }
    void loadUserProfileFresh(user.uid, user.email || "", { preferCacheFirst: true })
      .then((fresh) => {
        if (!fresh || hubState.currentUser?.uid !== user.uid) return;
        hubState.currentUserProfile = fresh;
        writeLoginProfileCache(user.uid, fresh);
        applyHubOpsChrome(user);
        paintHubTournamentList();
      })
      .catch((err) => console.warn("hub session profile refresh:", err));
  }

  if (!hubState.tournamentsListReady || !hubState.tournamentsCache.length) {
    void loadTournaments()
      .then(() => {
        if (hubState.currentUser?.uid !== user.uid) return;
        hubState.tournamentsListReady = true;
        hubState.tournamentsBootstrapping = false;
        paintHubTournamentList();
      })
      .catch((err) => console.warn("hub session tournaments refresh:", err));
  }

  if (hubRefs.adminModal?.classList.contains("show") && !hubState.usersCache.length) {
    void loadAllUsers({ forceServer: false }).then(() => renderAdminUserList());
  }
}

function paintHubTournamentList() {
  scheduleHubTournamentsRender();
}

/** Access Manage는 시스템 admin 이메일만 필요 — Firestore 프로필·대회 로드 전에 표시 */
function applyHubAccessChromeEarly(user) {
  if (!user) return;
  applyHubOpsChrome(user);
  if (!isSystemAdminEmail(user.email || "")) return;
  seedHubUsersFromSessionCache();
  void prefetchHubUsersCache()
    .then(() => {
      if (hubState.currentUser?.uid !== user.uid) return;
      if (hubRefs.adminModal?.classList.contains("show")) renderAdminUserList();
    })
    .catch((err) => {
      console.warn("prefetchHubUsersCache:", err);
    });
  void loadAllUsers()
    .then(() => {
      if (hubState.currentUser?.uid !== user.uid) return;
      if (hubRefs.adminModal?.classList.contains("show")) renderAdminUserList();
    })
    .catch((err) => {
      console.warn("preload loadAllUsers:", err);
    });
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
  if (!hubState.tournamentsCache.length) {
    hubState.tournamentsBootstrapping = true;
  }

  const cachedProfile = readLoginProfileCache(user.uid);
  if (cachedProfile) {
    hubState.currentUserProfile = cachedProfile;
    writeLoginProfileCache(user.uid, hubState.currentUserProfile);
    if (hubState.tournamentsCache.length > 0) {
      paintHubTournamentList();
    }
  }

  applyHubAccessChromeEarly(user);

  try {
  bootTimeoutId = window.setTimeout(() => {
    if (flow !== hubState.hubAuthFlowGen) return;
    if (!hubRefs.eventListEl?.classList.contains("event-list--loading")) return;
    if (!hubState.tournamentsCache.length) {
      seedHubTournamentsFromSessionCache();
    }
    hubState.tournamentsListReady = true;
    hubState.tournamentsBootstrapping = false;
    paintHubTournamentList();
  }, 2500);

  let [profile] = await Promise.all([
    raceFirestoreTimeout(
      loadUserProfileFresh(user.uid, user.email || "", { preferCacheFirst: true }),
      4000
    ).catch(() => hubState.currentUserProfile || null),
    raceFirestoreTimeout(loadTournaments(), 8000)
      .catch(() => hubState.tournamentsCache)
      .finally(() => {
        if (flow !== hubState.hubAuthFlowGen) return;
        hubState.tournamentsListReady = true;
        hubState.tournamentsBootstrapping = false;
      })
  ]);

  void loadUserProfileRevalidated(user.uid, user.email || "")
    .then((fresh) => {
      if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;
      if (!fresh) return;
      hubState.currentUserProfile = fresh;
      writeLoginProfileCache(user.uid, fresh);
      applyHubOpsChrome(user);
      paintHubTournamentList();
    })
    .catch((err) => console.warn("hub profile revalidate:", err));
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
  applyHubOpsChrome(user);
  paintHubTournamentList();
  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  scheduleBackgroundUserProfileSync(user);

  bindTournamentsRealtime();
  bindMyProfileRealtime(user.uid);

  if (isAppDebugEnabled()) {
    console.debug("[HUB AUTH]", {
      uid: user.uid,
      email: user.email || "",
      profile: hubState.currentUserProfile,
      isAdmin: hubState.currentUserProfile?.role === "admin"
    });
  }

  applyHubAccessChromeEarly(user);

  syncPushOfferButton(hubRefs.hubEnablePushBtn, user.uid);
  void bootstrapAppPush(user.uid);
  bindGlobalSeatNotificationWatch(user);
  if (disposeGlobalSeatNotifyVisibility) disposeGlobalSeatNotifyVisibility();
  disposeGlobalSeatNotifyVisibility = wireGlobalSeatNotificationVisibilityResync(user);
  flushAppBadgeIfVisible();

  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;
  bindHubForegroundAccessResync(user.uid);

  const isAdmin = getIsAdminUser(user, hubState.currentUserProfile);
  if (!isAdmin) {
    bindHubPeriodicAccessResync(user.uid);
  } else {
    disposeHubPeriodicAccessResync();
  }
  } finally {
    if (bootTimeoutId) clearTimeout(bootTimeoutId);
    hubState.tournamentsBootstrapping = false;
    if (!hubState.tournamentsListReady) hubState.tournamentsListReady = true;
    if (flow === hubState.hubAuthFlowGen && hubState.currentUser?.uid === user.uid) {
      paintHubTournamentList();
    }
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    hubSessionUid = "";
    hubState.hubAuthFlowGen = 0;
    hubState.currentUser = null;
    hubState.currentUserProfile = null;
    disposeGlobalSeatNotificationWatch();
    if (disposeGlobalSeatNotifyVisibility) {
      disposeGlobalSeatNotifyVisibility();
      disposeGlobalSeatNotifyVisibility = null;
    }
    disposeHubSessionWatches();
    location.replace("./login.html");
    return;
  }

  if (isSameAuthSession(hubSessionUid, user)) {
    hubState.currentUser = user;
    applyHubAccessChromeEarly(user);
    if (!hubState.currentUserProfile || !hubState.tournamentsListReady) {
      void bootstrapHubSession(user);
    } else {
      ensureHubSessionContinuity(user);
    }
    void bootstrapAppPush(user.uid);
    bindGlobalSeatNotificationWatch(user);
    return;
  }

  hubSessionUid = user.uid;
  hubState.currentUser = user;
  applyHubAccessChromeEarly(user);
  disposeHubSessionWatches();

  const run = bootstrapHubSession(user)
    .catch((err) => {
      console.error("hub auth init error:", err);
      hubState.tournamentsBootstrapping = false;
      hubState.tournamentsListReady = true;
      if (!hubState.tournamentsCache.length) {
        seedHubTournamentsFromSessionCache();
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
