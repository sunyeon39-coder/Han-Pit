import { auth, db } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { GL, initGlFromUrl, initGlDomRefs } from "./state.js";
import { canManageTournamentOps, canUseTournamentOps, isAdminEmail } from "../shared/auth-helpers.js";
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
import { loadUserProfileFresh } from "../shared/load-user-profile.js";

let globalLayoutMobileSeatNotify = null;

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

  function applyGlobalLayoutOpsPermissions(user, meta = {}) {
    GL.userProfile = GL.userProfile || {};
    const hadOps = GL.isAdminUser === true;
    const canOps =
      isAdminEmail(user?.email || "") ||
      canUseTournamentOps(user?.email, GL.userProfile, GL.tournamentId);

    if (!canOps && meta.fromCache && hadOps) return;

    GL.isAdminUser = canOps;
    GL.layoutAccentColor = resolveLayoutAccentColor(
      GL.userProfile,
      user?.uid || "",
      user?.email || ""
    );

    if (!canOps) {
      if (!meta.fromCache) {
        alert("운영 권한이 없습니다. 허브에서 대회 접근을 확인해 주세요.");
        location.replace("./index.html");
      }
      return;
    }

    refreshGlobalLayoutAdminUi();
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

    try {
      GL.currentUser = user;
      GL.userProfile = readBootUserProfile(user);
      seedMyUserProfileCache(GL.userProfile);
      GL.isAdminUser =
        isAdminEmail(user.email || "") ||
        canUseTournamentOps(user.email, GL.userProfile, GL.tournamentId);
      GL.layoutAccentColor = resolveLayoutAccentColor(
        GL.userProfile,
        user.uid,
        user.email || ""
      );

      if (!GL.isAdminUser) {
        const serverProfile = await loadUserProfileFresh(user.uid, user.email || "", {
          preferCacheFirst: true
        });
        GL.userProfile = serverProfile || GL.userProfile;
        seedMyUserProfileCache(GL.userProfile);
        GL.isAdminUser =
          isAdminEmail(user.email || "") ||
          canUseTournamentOps(user.email, GL.userProfile, GL.tournamentId);
        if (!GL.isAdminUser) {
          alert("운영 권한이 없습니다. 허브에서「직접 허용」을 받았는지, 같은 대회로 들어왔는지 확인해 주세요.");
          location.replace("./index.html");
          return;
        }
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

      void loadUserProfileFresh(user.uid, user.email || "", { preferCacheFirst: true }).then(
        (fresh) => {
          if (!fresh) return;
          GL.userProfile = fresh;
          GL.isAdminUser =
            isAdminEmail(user.email || "") ||
            canManageTournamentOps(user.email, GL.userProfile, GL.tournamentId);
          refreshGlobalLayoutAdminUi();
        }
      );

      void normalizeAndPersistUserRole(user.uid, GL.userProfile, user.email || "")
        .then((profile) => {
          if (!profile) return;
          GL.userProfile = profile;
          GL.isAdminUser =
            isAdminEmail(user.email || "") ||
            canManageTournamentOps(user.email, GL.userProfile, GL.tournamentId);
          refreshGlobalLayoutAdminUi();
        })
        .catch((err) => {
          console.error("normalizeAndPersistUserRole error:", err);
        });
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
    } catch (err) {
      console.error("global layout init error:", err);
      alert("통합 배치도를 불러오지 못했습니다.");
    }
  });
}
