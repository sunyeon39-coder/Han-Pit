import { auth, db } from "../firebase.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { logout } from "../auth.js";

import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { resolveStoredUserRole } from "../shared/auth-helpers.js";
import { getIsAdminUser } from "./hub-helpers.js";
import { closeModal, openModal } from "../shared/dom-utils.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";

import { initHubRefs, hubRefs } from "./hub-dom-refs.js";
import { hubState } from "./hub-state.js";
import { renderTournaments, showHubListLoading } from "./hub-tournament-list.js";
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
  resyncHubAccessFromServer
} from "./hub-loaders-realtime.js";
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
showHubListLoading();

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

adminBtn?.addEventListener("click", async () => {
  const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);

  if (!isAdmin) return;

  if (!hubState.tournamentsCache.length) {
    await loadTournaments();
  }
  if (!hubState.usersCache.length) {
    await loadAllUsers();
  }

  clearAdminBulkSelection();
  populateTournamentSelect();
  renderAdminUserList();
  openModal(adminModal);
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
  renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);
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
  showHubListLoading();

  const [profile] = await Promise.all([
    loadUserProfile(user.uid, user.email || ""),
    loadTournaments()
  ]);
  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  hubState.currentUserProfile = profile;
  if (!hubState.currentUserProfile) {
    const fallbackProfile = {
      email: user.email || "",
      nickname: user.displayName || "",
      role: resolveStoredUserRole(user.email || "", {}),
      accessCode: "",
      allowedEvents: {}
    };

    await setDoc(doc(db, "users", user.uid), fallbackProfile, { merge: true });
    hubState.currentUserProfile = fallbackProfile;
  }

  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  paintHubTournamentList();

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
    void loadAllUsers().catch((err) => {
      console.warn("loadAllUsers (background):", err);
    });
  } else {
    adminBtn?.classList.add("hidden");
  }

  syncPushOfferButton(hubRefs.hubEnablePushBtn, user.uid);
  void refreshFcmTokenIfGranted(user.uid);
  flushAppBadgeIfVisible();

  if (flow !== hubState.hubAuthFlowGen || hubState.currentUser?.uid !== user.uid) return;

  bindTournamentsRealtime();
  bindMyProfileRealtime(user.uid);
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
  showHubListLoading();

  const run = bootstrapHubSession(user)
    .catch((err) => {
      console.error("hub auth init error:", err);
      paintHubTournamentList();
      alert("허브 데이터를 불러오지 못했습니다.");
    })
    .finally(() => {
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
