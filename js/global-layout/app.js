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
import { restoreGlobalUndoStackFromSession } from "./undo-stack.js";
import {
  bindRealtime,
  disposeGlobalLayoutRealtime,
  hasGlobalSeatsServerSynced,
  refreshGlobalLayoutOpsDataFromServer,
  scheduleHealMissingWaitingFromAttendance
} from "./realtime.js";
import { armFirestoreStallWatchdog, showFirestoreStallBanner } from "../shared/firestore-stall-recovery.js";
import { readGlobalSeatsCache, readGlobalSeatsLegacyCache } from "./global-seats-session-cache.js";
import { readIndexGlobalWaitingCache } from "../index/index-ops-session-cache.js";
import { bindGlobalLayoutEventHandlers, syncGlobalLayoutMobileChrome } from "./ui-events.js";
import {
  initGlobalLayoutZoomBarDom,
  wireGlobalLayoutZoomBarOnce
} from "./canvas-viewport.js";
import { refreshGlobalLayoutMobileTimers, wireGlobalLayoutMobileEventsOnce } from "./mobile-panel-render.js";
import { initGlobalLayoutTopicBarDom, renderGlobalLayoutTopicBar } from "./topic-bar.js";
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
import { canManageGlobalLayoutOps } from "./ops-access.js";
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
  // index.html 등 다른 페이지로 이동했다 되돌아와도(뒤로가기 포함) 되돌리기 기록이
  // 남아있도록 sessionStorage 에 저장된 undo/redo 스택을 복원한다.
  restoreGlobalUndoStackFromSession();
  instantDismissAllBootLoaders();
  markPageBootLoaded(GL.app);
  // 진입 즉시 마지막으로 본 좌석을 캔버스에 그려 반응성을 높인다(이후 realtime 이 최신값으로 교체).
  const cachedSeats =
    readGlobalSeatsCache(GL.tournamentId) || readGlobalSeatsLegacyCache(GL.tournamentId);
  if (cachedSeats?.length) {
    GL.globalSeats = cachedSeats;
    renderSeats(cachedSeats);
  } else {
    renderSeats([]);
  }
  const cachedWaiting = readIndexGlobalWaitingCache(GL.tournamentId);
  if (cachedWaiting?.length) {
    GL.globalWaiting = cachedWaiting;
  }
  initGlobalLayoutZoomBarDom();
  wireGlobalLayoutZoomBarOnce();
  initGlobalLayoutTopicBarDom();
  bindGlobalLayoutPushUiOnce();
  bindGlobalLayoutEventHandlers();
  const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
  void ensureForegroundFcmBadgeListener();

  function refreshGlobalLayoutAdminUi() {
    syncGlobalLayoutMobileChrome();
    document.body.classList.toggle("gl-view-only", !canManageGlobalLayoutOps());
    renderSeats(GL.globalSeats);
    renderWaiting(getCurrentTournamentWaiting());
    renderSeatPanel();
    updateGlobalMetaToolbar();
    checkGlobalLayoutOptimisticSeatAlert();
    scheduleHealMissingWaitingFromAttendance();
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

    const bootProfile = readBootUserProfile(user, GL.userProfile || {});
    GL.userProfile = bootProfile;
    seedMyUserProfileCache(bootProfile);
    if (syncGlobalLayoutOpsFromProfile(user)) {
      GL.opsServerVerified = true;
      return true;
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
        if (!syncGlobalLayoutOpsFromProfile(user, { fromCache: false })) {
          if (globalLayoutSessionStarted && GL.opsServerVerified) return null;
          applyGlobalLayoutOpsPermissions(user, { fromCache: false });
          return null;
        }
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
      if (globalLayoutSessionStarted) {
        console.warn("[global-layout] ops deny during session — keeping layout visible");
        return;
      }
      if (meta.fromCache) return;
      GL.opsServerVerified = false;
      alert("운영 권한이 없습니다. 허브에서 대회 접근을 확인해 주세요.");
      location.replace("./index.html");
      return;
    }

    GL.opsServerVerified = true;
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
    GL.topicText = String(GL.currentTournament?.topicText || "");
    renderGlobalLayoutTopicBar();
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
    void refreshGlobalLayoutOpsDataFromServer().then(() => refreshGlobalLayoutAdminUi());
    armFirestoreStallWatchdog({
      timeoutMs: 8000,
      dataReady: () => hasGlobalSeatsServerSynced(),
      onStall: () =>
        showFirestoreStallBanner(
          "좌석 데이터를 불러오지 못했습니다(연결 지연). 연결 새로고침을 눌러 주세요."
        )
    });
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
      GL.userProfile = readLoginProfileCache(user.uid) || readBootUserProfile(user);
      seedMyUserProfileCache(GL.userProfile);
      markPageBootLoaded(GL.app);

      await loadGlobalLayoutTournamentMeta();

      if (syncGlobalLayoutOpsFromProfile(user)) {
        GL.opsServerVerified = true;
        startGlobalLayoutSession(user);
        void ensureGlobalLayoutOpsChrome(user);
        void refreshGlobalLayoutOpsProfileBackground(user);
        return;
      }

      const hasOps = await ensureGlobalLayoutOpsChrome(user);
      if (hasOps) {
        startGlobalLayoutSession(user);
        void refreshGlobalLayoutOpsProfileBackground(user);
        return;
      }

      GL.userProfile = readBootUserProfile(user, GL.userProfile || {});
      seedMyUserProfileCache(GL.userProfile);
      if (syncGlobalLayoutOpsFromProfile(user)) {
        GL.opsServerVerified = true;
        startGlobalLayoutSession(user);
        void refreshGlobalLayoutOpsProfileBackground(user);
        return;
      }

      if (layoutIsMobile()) {
        alert("통합 배치도는 PC에서만 볼 수 있습니다.");
        location.replace("./index.html");
        return;
      }

      // 운영 권한은 없지만 PC 사용자 — 캔버스만 보이는 조회 전용 세션 시작
      GL.opsServerVerified = false;
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
