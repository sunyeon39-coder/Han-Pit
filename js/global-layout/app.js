import { auth, db } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { GL, initGlFromUrl, initGlDomRefs } from "./state.js";
import { resolveLayoutAccentColor } from "../shared/layout-operator-colors.js";
import { clearMyWaitingPick } from "./waiting-picks.js";
import { layoutIsMobile, ALERT_VOLUME, SOUND_ENABLED_KEY } from "../layout/layout-main-route-env.js";
import { createLayoutSeatNotifyController } from "../layout/seat-notify-controller.js";
import { layoutAcknowledgeMyNotification } from "../layout/layout-main-remote.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  registerOptimisticSeatAssignedAlertHandler
} from "../shared/optimistic-seat-assigned-notify.js";
import { FCM_VAPID_KEY as VAPID_KEY } from "../shared/fcm-web-push.js";
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
import {
  alertFcmRegistrationResult,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  refreshFcmTokenIfGranted,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";
import { normalizeAndPersistUserRole } from "../login/user-sync.js";
import {
  ensureDocumentShellBackground,
  markPageBootLoaded
} from "../shared/page-boot-shell.js";
import {
  bindMyUserProfileRealtime,
  disposeMyUserProfileRealtime,
  seedMyUserProfileCache
} from "../shared/bind-my-user-profile-realtime.js";
import { readBootUserProfile } from "../shared/login-profile-cache.js";
import {
  loadUserProfileForTournamentOps,
  raceFirestoreTimeout
} from "../shared/load-user-profile.js";
import { writeLoginProfileCache } from "../shared/login-profile-cache.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";

let globalLayoutMobileSeatNotify = null;

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (GL.app && GL.app.dataset.pageBootLoaded !== "1") {
    renderSeats([]);
  }
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
    if (GL.activeTab === "seat") renderSeatPanel();
    updateGlobalMetaToolbar();
    checkGlobalLayoutOptimisticSeatAlert();
  }

  function syncGlobalLayoutOpsFromProfile(user = GL.currentUser) {
    if (!user) return false;
    GL.userProfile = GL.userProfile || {};
    const canOps = canShowTournamentOpsUi(
      user.email,
      GL.userProfile,
      GL.tournamentId,
      null,
      user.uid
    );
    GL.isAdminUser = canOps;
    GL.layoutAccentColor = resolveLayoutAccentColor(
      GL.userProfile,
      user.uid || "",
      user.email || ""
    );
    return canOps;
  }

  async function ensureGlobalLayoutOpsChrome(user = GL.currentUser) {
    if (!user?.uid) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (syncGlobalLayoutOpsFromProfile(user)) return true;

      const profile = await raceFirestoreTimeout(
        loadUserProfileForTournamentOps(user.uid, user.email || "", GL.tournamentId),
        10000
      );
      if (profile) {
        GL.userProfile = profile;
        seedMyUserProfileCache(profile);
        writeLoginProfileCache(user.uid, profile);
      }
      if (syncGlobalLayoutOpsFromProfile(user)) return true;

      await sleep(600 + attempt * 400);
    }
    return syncGlobalLayoutOpsFromProfile(user);
  }

  function applyGlobalLayoutOpsPermissions(user, meta = {}) {
    const canOps = syncGlobalLayoutOpsFromProfile(user);

    if (!canOps) {
      if (!meta.fromCache) {
        alert("운영 권한이 없습니다. 허브에서 대회 접근을 확인해 주세요.");
        location.replace("./index.html");
      }
      return;
    }

    refreshGlobalLayoutAdminUi();
  }

  function startGlobalLayoutSession(user) {
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
    void refreshFcmTokenIfGranted(user.uid);
    flushAppBadgeIfVisible();
    ensureGlobalLayoutMobileSeatNotify(user);

    setPanelOpen(false);
    bindRealtime();
    markPageBootLoaded(GL.app);
    refreshGlobalLayoutAdminUi();

    if (GL.timerHandle) clearInterval(GL.timerHandle);
    GL.timerHandle = setInterval(() => {
      if (isTypingInPanel()) return;
      if (layoutIsMobile()) {
        void import("./mobile-panel-render.js")
          .then((m) => m.refreshGlobalLayoutMobileTimers())
          .catch((err) => console.error("refreshGlobalLayoutMobileTimers error:", err));
        return;
      }
      updateCanvasSeatTimerClasses();
      if (GL.activeTab === "seat") {
        updateSeatPanelTimers();
      } else {
        updateWaitingTimersInPanel();
      }
    }, 1000);
  }

  window.addEventListener("beforeunload", () => {
    disposeGlobalLayoutRealtime();
    void clearMyWaitingPick();
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      disposeMyUserProfileRealtime();
      void clearMyWaitingPick();
      location.replace("./login.html");
      return;
    }

    const bootUiTimeout = window.setTimeout(() => {
      if (GL.app?.dataset.pageBootLoaded !== "1") markPageBootLoaded(GL.app);
    }, 5000);

    try {
      GL.currentUser = user;
      GL.userProfile = readBootUserProfile(user);
      seedMyUserProfileCache(GL.userProfile);

      let sessionStarted = false;
      if (syncGlobalLayoutOpsFromProfile(user)) {
        startGlobalLayoutSession(user);
        sessionStarted = true;
      }

      const hasOps = await ensureGlobalLayoutOpsChrome(user);
      if (!hasOps) {
        alert(
          "운영 권한이 없습니다. 허브에서「직접 허용」을 받았는지, 같은 대회로 들어왔는지 확인해 주세요."
        );
        location.replace("./index.html");
        return;
      }

      if (!sessionStarted) {
        startGlobalLayoutSession(user);
      } else {
        refreshGlobalLayoutAdminUi();
      }

      void loadUserProfileForTournamentOps(user.uid, user.email || "", GL.tournamentId)
        .then((fresh) => {
          if (!fresh) return;
          GL.userProfile = fresh;
          writeLoginProfileCache(user.uid, fresh);
          syncGlobalLayoutOpsFromProfile(user);
          refreshGlobalLayoutAdminUi();
        })
        .catch((err) => console.warn("global-layout ops profile refresh:", err));

      void normalizeAndPersistUserRole(user.uid, GL.userProfile, user.email || "")
        .then((profile) => {
          if (!profile) return;
          GL.userProfile = profile;
          writeLoginProfileCache(user.uid, profile);
          syncGlobalLayoutOpsFromProfile(user);
          refreshGlobalLayoutAdminUi();
        })
        .catch((err) => {
          console.error("normalizeAndPersistUserRole error:", err);
        });
    } catch (err) {
      console.error("global layout init error:", err);
      const detail = String(err?.message || err || "").trim();
      alert(
        detail
          ? `통합 배치도를 불러오지 못했습니다.\n(${detail})`
          : "통합 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
      );
      markPageBootLoaded(GL.app);
    } finally {
      clearTimeout(bootUiTimeout);
    }
  });
}
