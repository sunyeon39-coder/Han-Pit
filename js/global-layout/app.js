import { auth, db } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { GL, initGlFromUrl, initGlDomRefs } from "./state.js";
import { resolveLayoutAccentColor } from "../shared/layout-operator-colors.js";
import { clearMyWaitingPick, pruneOperatorPicksWithoutOps, refreshOperatorPicksFromServer } from "./waiting-picks.js";
import { layoutIsMobile, ALERT_VOLUME, SOUND_ENABLED_KEY } from "../layout/layout-main-route-env.js";
import { createLayoutSeatNotifyController } from "../layout/seat-notify-controller.js";
import { layoutAcknowledgeMyNotification } from "../layout/layout-main-remote.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  registerOptimisticSeatAssignedAlertHandler
} from "../shared/optimistic-seat-assigned-notify.js";
import {
  FCM_VAPID_KEY as VAPID_KEY,
  alertFcmRegistrationResult,
  bootstrapAppPush,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import {
  updateCanvasSeatTimerClasses,
  updateSeatPanelTimers,
  renderSeats,
  renderSeatPanel,
  renderWaiting,
  updateWaitingTimersInPanel,
  setPanelOpen,
  isTypingInPanel
} from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { bindRealtime, disposeGlobalLayoutRealtime } from "./realtime.js";
import { bindGlobalLayoutEventHandlers, syncGlobalLayoutMobileChrome } from "./ui-events.js";
import {
  initGlobalLayoutZoomBarDom,
  wireGlobalLayoutZoomBarOnce
} from "./canvas-viewport.js";
import { refreshGlobalLayoutMobileTimers, wireGlobalLayoutMobileEventsOnce } from "./mobile-panel-render.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";
import { normalizeAndPersistUserRole } from "../login/user-sync.js";
import {
  ensureDocumentShellBackground,
  instantDismissAllBootLoaders,
  markPageBootLoaded
} from "../shared/page-boot-shell.js";
import { isSameAuthSession } from "../shared/auth-session-guard.js";
import {
  readBootUserProfile,
  readLoginProfileCache,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";
import {
  bindMyUserProfileRealtime,
  disposeMyUserProfileRealtime,
  seedMyUserProfileCache
} from "../shared/bind-my-user-profile-realtime.js";
import {
  loadUserProfileForTournamentOps,
  raceFirestoreTimeout
} from "../shared/load-user-profile.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { isSystemAdminEmail } from "../shared/auth-helpers.js";
import {
  globalLayoutTournamentMeta,
  loadGlobalLayoutTournamentMeta
} from "./tournament-meta.js";

let globalLayoutMobileSeatNotify = null;
let globalLayoutSessionUid = "";
let globalLayoutSessionStarted = false;
let globalLayoutOpsRefreshInflight = null;

function ensureGlobalLayoutMobileSeatNotify(user) {
  if (!layoutIsMobile() || !user?.uid) return null;
  if (!globalLayoutMobileSeatNotify) {
    globalLayoutMobileSeatNotify = createLayoutSeatNotifyController({
      soundEnabledKey: SOUND_ENABLED_KEY,
      alertVolume: ALERT_VOLUME,
      vapidKey: VAPID_KEY,
      getCurrentUser: () => GL.currentUser || user,
      acknowledgeNotification: () => layoutAcknowledgeMyNotification(GL.currentUser || user)
    });
    registerOptimisticSeatAssignedAlertHandler((payload) =>
      globalLayoutMobileSeatNotify.showOptimisticSeatAssignedAlert(payload)
    );
  }
  globalLayoutMobileSeatNotify.bindMyNotificationWatch();
  return globalLayoutMobileSeatNotify;
}

function checkGlobalLayoutOptimisticSeatAlert() {
  if (!layoutIsMobile()) return;
  const user = GL.currentUser;
  if (!user?.uid) return;
  maybeShowOptimisticSeatAlertFromSeats(GL.globalSeats, {
    user,
    profile: GL.userProfile,
    buildTargetUrl: (eventId, boxId, seatId) =>
      `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(seatId)}`,
    showAlert: (payload) =>
      globalLayoutMobileSeatNotify?.showOptimisticSeatAssignedAlert?.(payload) ?? false
  });
}

function bindGlobalLayoutPushUiOnce() {
  const btn = GL.enablePushBtn;
  if (!btn || btn.dataset.glPushBound === "1") return;
  btn.dataset.glPushBound = "1";
  btn.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (!u?.uid) {
      alert("로그인을 확인하는 중입니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    const r = await registerFcmWebPushAndSave(u.uid);
    alertFcmRegistrationResult(r);
    syncPushOfferButton(btn, u.uid);
  });
}

export function startGlobalLayoutApp() {
  ensureDocumentShellBackground();
  initGlFromUrl();
  initGlDomRefs();
  instantDismissAllBootLoaders();
  markPageBootLoaded(GL.app);
  renderSeats([]);
  initGlobalLayoutZoomBarDom();
  wireGlobalLayoutZoomBarOnce();
  bindGlobalLayoutPushUiOnce();
  bindGlobalLayoutEventHandlers();
  const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
  void ensureForegroundFcmBadgeListener();

  function refreshGlobalLayoutAdminUi() {
    syncGlobalLayoutMobileChrome();
    renderSeats(GL.globalSeats);
    renderWaiting(getCurrentTournamentWaiting());
    renderSeatPanel();
    updateGlobalMetaToolbar();
    checkGlobalLayoutOptimisticSeatAlert();
  }

  function syncGlobalLayoutOpsFromProfile(user = GL.currentUser, meta = {}) {
    if (!user) return false;
    GL.userProfile = GL.userProfile || {};
    const canOps = canShowTournamentOpsUi(
      user.email,
      GL.userProfile,
      GL.tournamentId,
      globalLayoutTournamentMeta(),
      user.uid
    );
    const wasAdmin = GL.isAdminUser === true;
    GL.isAdminUser = canOps;
    GL.layoutAccentColor = resolveLayoutAccentColor(
      GL.userProfile,
      user.uid || "",
      user.email || ""
    );
    if (wasAdmin && !canOps) {
      GL.selectedWaitingId = "";
      void clearMyWaitingPick();
    }
    if (!canOps) {
      const myUid = String(user?.uid || "").trim();
      if (myUid && GL.operatorPicks?.[myUid]) {
        const next = { ...(GL.operatorPicks || {}) };
        delete next[myUid];
        GL.operatorPicks = next;
      }
    }
    return canOps;
  }

  async function ensureGlobalLayoutOpsChrome(user = GL.currentUser) {
    if (!user?.uid) return false;
    if (isSystemAdminEmail(user.email || "")) {
      const canOps = syncGlobalLayoutOpsFromProfile(user);
      if (canOps) GL.opsServerVerified = true;
      return canOps;
    }

    await loadGlobalLayoutTournamentMeta();
    const tournamentMeta = globalLayoutTournamentMeta();

    const cachedProfile = readLoginProfileCache(user.uid);
    if (cachedProfile) {
      GL.userProfile = cachedProfile;
      seedMyUserProfileCache(cachedProfile);
      if (syncGlobalLayoutOpsFromProfile(user)) {
        GL.opsServerVerified = true;
        return true;
      }
    }

    let profile = await raceFirestoreTimeout(
      loadUserProfileForTournamentOps(user.uid, user.email || "", GL.tournamentId, {
        preferCacheFirst: true,
        tournamentMeta
      }),
      8000
    );
    if (profile) {
      GL.userProfile = profile;
      seedMyUserProfileCache(profile);
      writeLoginProfileCache(user.uid, profile);
    }
    if (syncGlobalLayoutOpsFromProfile(user)) {
      GL.opsServerVerified = true;
      return true;
    }

    profile = await raceFirestoreTimeout(
      loadUserProfileForTournamentOps(user.uid, user.email || "", GL.tournamentId, {
        preferCacheFirst: false,
        tournamentMeta
      }),
      8000
    );
    if (profile) {
      GL.userProfile = profile;
      seedMyUserProfileCache(profile);
      writeLoginProfileCache(user.uid, profile);
    }
    const canOps = syncGlobalLayoutOpsFromProfile(user);
    if (canOps) GL.opsServerVerified = true;
    return canOps;
  }

  function refreshGlobalLayoutOpsProfileBackground(user = GL.currentUser) {
    if (!user?.uid || globalLayoutOpsRefreshInflight) return globalLayoutOpsRefreshInflight;
    globalLayoutOpsRefreshInflight = loadUserProfileForTournamentOps(
      user.uid,
      user.email || "",
      GL.tournamentId,
      { preferCacheFirst: false, tournamentMeta: globalLayoutTournamentMeta() }
    )
      .then((fresh) => {
        if (!fresh || globalLayoutSessionUid !== user.uid) return null;
        GL.userProfile = fresh;
        writeLoginProfileCache(user.uid, fresh);
        applyGlobalLayoutOpsPermissions(user, { fromCache: false });
        if (!GL.isAdminUser) return null;
        return normalizeAndPersistUserRole(user.uid, GL.userProfile, user.email || "");
      })
      .then((profile) => {
        if (!profile || globalLayoutSessionUid !== user.uid) return;
        GL.userProfile = profile;
        writeLoginProfileCache(user.uid, profile);
        applyGlobalLayoutOpsPermissions(user, { fromCache: false });
      })
      .catch((err) => {
        console.warn("global-layout ops profile refresh:", err?.code || err);
      })
      .finally(() => {
        globalLayoutOpsRefreshInflight = null;
      });
    return globalLayoutOpsRefreshInflight;
  }

  function applyGlobalLayoutOpsPermissions(user, meta = {}) {
    const canOps = syncGlobalLayoutOpsFromProfile(user, meta);

    if (!canOps) {
      refreshGlobalLayoutAdminUi();
      if (!meta.fromCache) {
        GL.opsServerVerified = false;
        alert("운영 권한이 없습니다. 허브에서 대회 접근을 확인해 주세요.");
        location.replace("./index.html");
      }
      return;
    }

    refreshGlobalLayoutAdminUi();
  }

  function startGlobalLayoutSession(user) {
    if (globalLayoutSessionStarted) {
      refreshGlobalLayoutAdminUi();
      return;
    }
    globalLayoutSessionStarted = true;

    if (!GL.tournamentId) {
      alert("대회 정보가 없습니다. 인덱스에서 대회를 선택한 뒤 다시 열어 주세요.");
      location.replace("./index.html");
      return;
    }

    bindMyUserProfileRealtime(user.uid, {
      email: user.email || "",
      onProfileChange: (profile, meta) => {
        GL.userProfile = profile;
        applyGlobalLayoutOpsPermissions(user, meta);
      }
    });
    syncGlobalLayoutMobileChrome();
    if (GL.urlEventId && GL.urlBoxId) {
      sessionStorage.setItem("eventId", GL.urlEventId);
      sessionStorage.setItem("boxId", GL.urlBoxId);
    }
    syncPushOfferButton(GL.enablePushBtn, user.uid);
    void bootstrapAppPush(user.uid);
    flushAppBadgeIfVisible();
    ensureGlobalLayoutMobileSeatNotify(user);

    setPanelOpen(!layoutIsMobile());
    bindRealtime();
    void refreshOperatorPicksFromServer()
      .then(() => pruneOperatorPicksWithoutOps())
      .then(() => refreshGlobalLayoutAdminUi());
    markPageBootLoaded(GL.app);
    refreshGlobalLayoutAdminUi();

    if (layoutIsMobile()) wireGlobalLayoutMobileEventsOnce();
    startGlobalLayoutTimer();
  }

  function startGlobalLayoutTimer() {
    if (GL.timerHandle) clearInterval(GL.timerHandle);
    GL.timerHandle = setInterval(() => {
      if (document.visibilityState === "hidden" || isTypingInPanel()) return;
      if (layoutIsMobile()) {
        refreshGlobalLayoutMobileTimers();
        return;
      }
      updateCanvasSeatTimerClasses();
      updateSeatPanelTimers();
      updateWaitingTimersInPanel();
    }, 1000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (GL.timerHandle) {
        clearInterval(GL.timerHandle);
        GL.timerHandle = null;
      }
      return;
    }
    if (globalLayoutSessionStarted && !GL.timerHandle) {
      startGlobalLayoutTimer();
    }
  });

  window.addEventListener("beforeunload", () => {
    globalLayoutSessionStarted = false;
    disposeGlobalLayoutRealtime();
    void clearMyWaitingPick();
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      globalLayoutSessionUid = "";
      GL.opsServerVerified = false;
      disposeMyUserProfileRealtime();
      void clearMyWaitingPick();
      location.replace("./login.html");
      return;
    }

    if (isSameAuthSession(globalLayoutSessionUid, user)) {
      GL.currentUser = user;
      void bootstrapAppPush(user.uid);
      if (globalLayoutSessionStarted) refreshGlobalLayoutAdminUi();
      return;
    }

    globalLayoutSessionUid = user.uid;
    GL.opsServerVerified = false;

    try {
      GL.currentUser = user;
      GL.userProfile = readBootUserProfile(user);
      seedMyUserProfileCache(GL.userProfile);
      markPageBootLoaded(GL.app);

      await loadGlobalLayoutTournamentMeta();

      const hasOps = await ensureGlobalLayoutOpsChrome(user);
      if (!hasOps) {
        alert(
          "운영 권한이 없습니다. 허브에서「직접 허용」을 받았는지, 같은 대회로 들어왔는지 확인해 주세요."
        );
        location.replace("./index.html");
        return;
      }

      startGlobalLayoutSession(user);
      void refreshGlobalLayoutOpsProfileBackground(user);
    } catch (err) {
      console.error("global layout init error:", err);
      const detail = String(err?.message || err || "").trim();
      alert(
        detail
          ? `통합 배치도를 불러오지 못했습니다.\n(${detail})`
          : "통합 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
      );
      markPageBootLoaded(GL.app);
    }
  });
}
