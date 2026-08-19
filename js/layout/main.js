import { auth, db } from "../firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { escapeHtml } from "../shared/dom-utils.js";
import { createLayoutPersistServices } from "./layout-persist.js";
import {
  setLayoutDealerStatus,
  applyLayoutDealerAttendancePatchesBatched
} from "./dealer-attendance-remote.js";
import { createLayoutSeatNotifyController } from "./seat-notify-controller.js";
import {
  readBootUserProfile
} from "../shared/login-profile-cache.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  registerOptimisticSeatAssignedAlertHandler
} from "../shared/optimistic-seat-assigned-notify.js";
import { createLayoutCanvasViewport } from "./layout-canvas-viewport.js";
import { createLayoutCanvasBuild } from "./layout-canvas-build.js";
import { createLayoutLocalStateReconcile } from "./layout-local-state-reconcile.js";
import { createLayoutGlobalSeatsMerge } from "./layout-global-seats-merge.js";
import { createLayoutRealtimeBind } from "./layout-realtime-bind.js";
import { createLayoutDealerAttendanceSync } from "./layout-dealer-attendance-sync.js";
import { createLayoutDealerMoves } from "./layout-dealer-moves.js";
import { createLayoutUpdateTimers } from "./layout-update-timers.js";
import { createLayoutHealUndo } from "./layout-heal-undo.js";
import { createLayoutUiRender } from "./layout-ui-render.js";
import { createLayoutBootstrap } from "./layout-bootstrap.js";
import { createLayoutPanelRenderers } from "./layout-panel-render.js";
import {
  clone,
  makeUid,
  isEmptyPerson,
  sanitizeLayoutState,
  timerClass,
  fmtElapsed
} from "./layout-core-utils.js";
import {
  createLayoutMainRouteEnv,
  layoutIsMobile,
  VAPID_KEY,
  ALERT_VOLUME,
  SOUND_ENABLED_KEY
} from "./layout-main-route-env.js";
import { getWaitingTimerStartMs, getWaitingDisplayStartMs } from "./layout-main-waiting-time.js";
import {
  getIdentityKey,
  getWaitingIdentity,
  getSeatIdentity,
  isSeatAssignedToCurrentUser
} from "./layout-main-identity.js";
import {
  normalizeWaitingEntry as normalizeWaitingEntryCore,
  sortWaitingAscending
} from "./layout-main-waiting-normalize.js";
import {
  layoutLoadMyUserProfile,
  layoutLoadEventStateRemote,
  layoutLoadEventStateFromGlobalSeats,
  layoutLoadWaitingStateRemote,
  layoutAcknowledgeMyNotification,
  layoutRefreshCachedEventCardTitle,
  layoutGetBestDisplayName
} from "./layout-main-remote.js";
import {
  seatCanvasDigitsOnly,
  getSortedSeats as computeSortedSeatsForLayout
} from "./layout-main-display-helpers.js";
import { createLayoutSeatWaitingMutations } from "./layout-main-seat-waiting-mutations.js";
import { createSeatWaitingMutationQueue } from "./layout-seat-waiting-mutation-queue.js";
import { setupLayoutMainDomWiring } from "./layout-main-dom-wiring.js";
import {
  alertFcmRegistrationResult,
  bootstrapAppPush,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";
import { createLayoutRealtimeUi } from "./layout-realtime-ui.js";
import { markPageBootLoaded, instantDismissAllBootLoaders, ensureDocumentShellBackground } from "../shared/page-boot-shell.js";
import { isSameAuthSession } from "../shared/auth-session-guard.js";
import { raceFirestoreTimeout } from "../shared/load-user-profile.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import {
  bindMyUserProfileRealtime,
  disposeMyUserProfileRealtime,
  seedMyUserProfileCache
} from "../shared/bind-my-user-profile-realtime.js";

(() => {
  "use strict";

  const app = document.getElementById("app");
  ensureDocumentShellBackground();
  instantDismissAllBootLoaders();
  markPageBootLoaded(app);
  const menuBtn = document.getElementById("menuBtn");
  const backBtn = document.getElementById("backBtn");
  const pcPanel = document.getElementById("pcPanel");
  const panelContent = document.getElementById("panelContent");
  const mobileSheet = document.getElementById("mobileSheet");
  const mobileAddSeatBtn = document.getElementById("mobileAddSeat");
  const mobileAddWaitingBtn = document.getElementById("mobileAddWaiting");
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const enablePushBtn = document.getElementById("enablePushBtn");

  const isMobile = layoutIsMobile;

  const route = createLayoutMainRouteEnv();
  const attendanceWaitingState = { items: [], inactiveUids: new Set() };
  const {
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    EVENT_DOC_ID,
    LAYOUT_CANVAS_VIEW_KEY,
    EVENT_REF,
    WAITING_COLLECTION_REF,
    GLOBAL_SEATS_REF,
    getCurrentTournamentId,
    hasValidLayoutRouteContext,
    hasWritableLayoutContext
  } = route;

  const eventTitleCache = { cachedEventCardTitle: "" };

  let currentUser = null;
  let currentUserProfile = null;
  let isAdminUser = false;
  let timerHandle = null;
  let layoutHealUndo;
  let layoutDealerMoves;
  let layoutUi;
  let scheduleLayoutRealtimeUi = () => {};
  const layoutSeatNotifyBridge = {
    showOptimisticSeatAssignedAlert(payload) {
      return this._impl?.showOptimisticSeatAssignedAlert?.(payload) ?? false;
    }
  };

  async function undoLastAction() {
    return layoutHealUndo.undoLastAction();
  }

  function render() {
    if (!layoutUi) return;
    layoutUi.render();
    maybeShowOptimisticSeatAlertFromSeats(eventState.seats, {
      user: currentUser,
      profile: currentUserProfile,
      eventId: EVENT_ID,
      boxId: BOX_ID,
      eventTitle: getCurrentEventTitle(),
      buildTargetUrl: buildSeatTargetUrl,
      showAlert: (payload) => layoutSeatNotifyBridge.showOptimisticSeatAssignedAlert(payload)
    });
  }

  function renderPanel() {
    if (!layoutUi) return;
    layoutUi.renderPanel();
  }

  function renderBoxPanel() {
    if (!layoutUi) return;
    layoutUi.renderBoxPanel();
  }

  const eventState = {
    version: 2,
    eventId: EVENT_ID,
    boxId: BOX_ID,
    nextSeatNo: 1,
    nextSeatOrder: 1,
    seats: [],
    updatedAt: Date.now()
  };

  const waitingState = {
    version: 2,
    waiting: [],
    updatedAt: Date.now()
  };

  let lastLayoutEventFp = "";
  let lastLayoutWaitingFp = "";
  let lastLayoutGlobalSeatsFp = "";

  function layoutEventStateFingerprint() {
    return (eventState.seats || [])
      .map(
        (s) =>
          `${s.id}|${String(s.person || "").trim()}|${Number(s.seatedAt || 0)}|${String(s.label ?? s.no ?? "")}`
      )
      .join(";");
  }

  function layoutWaitingStateFingerprint() {
    return (waitingState.waiting || [])
      .map(
        (w) =>
          `${w.id}|${String(w.name || "").trim()}|${w.blockChecked === true ? 1 : 0}|${Number(w.joinedAt || 0)}`
      )
      .join(";");
  }

  const ui = {
  activeTab: "wait",
  selectedSeatId: FOCUS_SEAT_ID || null,
  selectedWaitingId: null,
  dragging: null,
  lastTouchTapAt: 0,
  lastTouchSeatId: "",
  lastMobileTapAt: 0,
  lastMobileSeatId: "",
  lastMouseClickAt: 0,
  lastMouseSeatId: "",
  lastUndoAction: null,
  seatSortMode: "seat",
  /** PC 캔버스: 패닝·축소 보기 (우측 패널에 가려진 영역 탐색용) */
  canvasPanX: 0,
  canvasPanY: 0,
  canvasZoom: 1
};

  const layoutTimers = createLayoutUpdateTimers({
    eventState,
    isEmptyPerson,
    timerClass,
    fmtElapsed
  });

  const layoutViewport = createLayoutCanvasViewport({
    ui,
    app,
    layoutCanvasViewKey: LAYOUT_CANVAS_VIEW_KEY
  });

  function getCurrentEventTitle() {
    const t = String(eventTitleCache.cachedEventCardTitle || "").trim();
    if (t) return t;
    return String(EVENT_ID || "").trim() || "이벤트";
  }

  async function refreshCachedEventCardTitle() {
    await layoutRefreshCachedEventCardTitle(TOURNAMENT_ID, EVENT_ID, eventTitleCache);
  }

  function buildSeatTargetUrl(eventId, boxId, seatId = "") {
    const tournamentId = getCurrentTournamentId();
    const params = new URLSearchParams();

    if (tournamentId) params.set("tournamentId", tournamentId);
    if (eventId) params.set("eventId", eventId);
    if (boxId) params.set("boxId", boxId);
    if (seatId) params.set("focusSeatId", seatId);

    return `./layout.html?${params.toString()}`;
  }

  function canManageLayout() {
    return isAdminUser === true;
  }

  function syncLayoutMobileAdminChrome() {
    const show = canManageLayout();
    if (mobileAddSeatBtn) mobileAddSeatBtn.style.display = show ? "" : "none";
    if (mobileAddWaitingBtn) mobileAddWaitingBtn.style.display = show ? "" : "none";
  }

  function applyLayoutOpsPermissions(meta = {}) {
    if (!currentUser) return;
    const canOps = canShowTournamentOpsUi(
      currentUser.email || "",
      currentUserProfile,
      TOURNAMENT_ID,
      null,
      currentUser.uid
    );

    isAdminUser = canOps;
    syncLayoutMobileAdminChrome();
    if (layoutUi) {
      render();
      renderPanel();
    }
  }

  // 좌석/대기 뮤테이션과 저장(saveEventState/saveWaitingState)이 동일한 in-flight 카운터를
  // 공유해야, 어떤 경로로 로컬 상태를 바꾸든(좌석 추가/삭제/비우기/드래그 이동 등) 저장이
  // 서버에 반영되기 전까지 실시간 스냅샷이 로컬 변경을 덮어쓰지 않는다.
  const layoutMutationQueue = createSeatWaitingMutationQueue();
  const {
    runSeatWaitingMutationSerialized,
    enqueueHealAfterMutation,
    beginLayoutOptimisticMutation,
    endLayoutOptimisticMutation,
    isLayoutOptimisticMutationInFlight
  } = layoutMutationQueue;

  const {
    saveEventState,
    saveWaitingState,
    writeUserNotification,
    clearUserSeatNotification,
    flushEventSaveNow,
    flushWaitingSaveNow,
    touchEvent,
    touchWaiting
  } = createLayoutPersistServices({
    tournamentId: TOURNAMENT_ID,
    eventId: EVENT_ID,
    boxId: BOX_ID,
    eventDocId: EVENT_DOC_ID,
    globalSeatsRef: GLOBAL_SEATS_REF,
    eventRef: EVENT_REF,
    waitingCollectionRef: WAITING_COLLECTION_REF,
    eventState,
    waitingState,
    clone,
    sanitizeLayoutState,
    isEmptyPerson,
    hasWritableLayoutContext,
    beginLayoutOptimisticMutation,
    endLayoutOptimisticMutation
  });

  function normalizeWaitingEntry(raw) {
    return normalizeWaitingEntryCore(raw, TOURNAMENT_ID);
  }

  const layoutLocalStateReconcile = createLayoutLocalStateReconcile({
    waitingState,
    eventState,
    isEmptyPerson,
    normalizeWaitingEntry,
    getWaitingIdentity,
    getSeatIdentity
  });

  let layoutGlobalSeatsMerge;

  const seatMutations = createLayoutSeatWaitingMutations({
    eventState,
    waitingState,
    ui,
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    getCurrentTournamentId,
    canManageLayout,
    isEmptyPerson,
    makeUid,
    getIdentityKey,
    getWaitingIdentity,
    getSeatIdentity,
    normalizeWaitingEntry,
    layoutViewport,
    getGlobalSeatsMerge: () => layoutGlobalSeatsMerge,
    getHealUndo: () => layoutHealUndo,
    getDealerMoves: () => layoutDealerMoves,
    getLocalReconcile: () => layoutLocalStateReconcile,
    touchEvent,
    touchWaiting,
    writeUserNotification,
    clearUserSeatNotification,
    getCurrentEventTitle,
    buildSeatTargetUrl,
    render,
    renderPanel,
    showOptimisticSeatAssignedAlert: (payload) =>
      layoutSeatNotifyBridge.showOptimisticSeatAssignedAlert(payload),
    getAttendanceWaiting: () => attendanceWaitingState.items,
    getAttendanceInactiveUids: () => attendanceWaitingState.inactiveUids,
    runSeatWaitingMutationSerialized,
    enqueueHealAfterMutation,
    beginLayoutOptimisticMutation,
    endLayoutOptimisticMutation,
    isLayoutOptimisticMutationInFlight
  });

  const {
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    assignWaitingToSeat,
    setWaitingBlockChecked,
    findSeat,
    getWaitingListForDisplay,
    clearWaitingSelectionIfSeated,
    removeWaitingEntriesByIdentity
  } = seatMutations;

  layoutGlobalSeatsMerge = createLayoutGlobalSeatsMerge({
    GLOBAL_SEATS_REF,
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    hasValidLayoutRouteContext,
    isEmptyPerson,
    getIdentityKey,
    eventState,
    clearSeatLocally: (seat) => layoutLocalStateReconcile.clearSeatLocally(seat),
    clearWaitingSelectionIfSeated,
    isLayoutOptimisticMutationInFlight,
    onAfterGlobalSeatsSnapshot: (merged) => {
      const fp = layoutEventStateFingerprint();
      if (fp === lastLayoutGlobalSeatsFp) return;
      lastLayoutGlobalSeatsFp = fp;
      scheduleLayoutRealtimeUi({
        canvas: true,
        panel: true,
        timers: true,
        ...(merged ? { heal: "global_seats_merge" } : {})
      });
    }
  });

  const layoutRealtime = createLayoutRealtimeBind({
    EVENT_REF,
    WAITING_COLLECTION_REF,
    TOURNAMENT_ID,
    attendanceWaitingState,
    eventState,
    waitingState,
    EVENT_ID,
    BOX_ID,
    normalizeWaitingEntry,
    applyGlobalSeatMapToEventSeats: () => layoutGlobalSeatsMerge.applyGlobalSeatMapToEventSeats(),
    isLayoutOptimisticMutationInFlight,
    onAfterEventRemoteSnapshot: () => {
      const fp = layoutEventStateFingerprint();
      if (fp === lastLayoutEventFp) return;
      lastLayoutEventFp = fp;
      scheduleLayoutRealtimeUi({ canvas: true, heal: "event_snapshot" });
    },
    onAfterWaitingRemoteSnapshot: () => {
      const fp = layoutWaitingStateFingerprint();
      if (fp === lastLayoutWaitingFp) return;
      lastLayoutWaitingFp = fp;
      scheduleLayoutRealtimeUi({ panel: true, heal: "waiting_snapshot" });
    },
    onAfterAttendanceRemoteSnapshot: () => {
      scheduleLayoutRealtimeUi({ panel: true, heal: "attendance_snapshot" });
    }
  });

  function getSortedSeats(list = []) {
    return computeSortedSeatsForLayout(list, ui.seatSortMode, isEmptyPerson);
  }

  const layoutPanels = createLayoutPanelRenderers({
    app,
    panelContent,
    ui,
    eventState,
    EVENT_ID,
    escapeHtml,
    isEmptyPerson,
    canManageLayout,
    getWaitingListForDisplay,
    getSortedSeats,
    getWaitingTimerStartMs,
    getWaitingDisplayStartMs,
    sortWaitingAscending,
    seatCanvasDigitsOnly,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    assignWaitingToSeat,
    setWaitingBlockChecked,
    undoLastAction,
    isSeatMine: (seat) => isSeatAssignedToCurrentUser(seat, currentUser, currentUserProfile),
    onFullRender: () => render(),
    onPanelRefresh: () => {
      renderPanel();
      layoutUi?.renderCanvasOnly?.();
    },
    onTimersUpdate: () => layoutTimers.updateTimers()
  });

  const layoutCanvas = createLayoutCanvasBuild({
    app,
    layoutViewport,
    ui,
    eventState,
    escapeHtml,
    timerClass,
    isEmptyPerson,
    canManageLayout,
    findSeat,
    assignWaitingToSeat,
    clearSeat,
    touchEvent,
    isSeatMine: (seat) => isSeatAssignedToCurrentUser(seat, currentUser, currentUserProfile),
    onFullRender: () => render(),
    onCanvasSync: () => {
      if (layoutUi?.renderCanvasOnly?.()) return;
      render();
    }
  });

  layoutUi = createLayoutUiRender({
    app,
    panelContent,
    tabs,
    ui,
    mobileSheet,
    isMobile,
    layoutPanels,
    layoutCanvas,
    layoutTimers
  });

  async function loadMyUserProfile() {
    return layoutLoadMyUserProfile();
  }

  async function loadEventStateRemote() {
    return layoutLoadEventStateRemote(EVENT_REF);
  }

  async function loadEventStateFromGlobalSeats() {
    return layoutLoadEventStateFromGlobalSeats(TOURNAMENT_ID, EVENT_ID, BOX_ID);
  }

  async function loadWaitingStateRemote() {
    return layoutLoadWaitingStateRemote(WAITING_COLLECTION_REF);
  }

  async function acknowledgeMyNotification() {
    await layoutAcknowledgeMyNotification(currentUser);
  }

  const seatNotify = createLayoutSeatNotifyController({
    soundEnabledKey: SOUND_ENABLED_KEY,
    alertVolume: ALERT_VOLUME,
    vapidKey: VAPID_KEY,
    getCurrentUser: () => currentUser,
    acknowledgeNotification: acknowledgeMyNotification
  });
  layoutSeatNotifyBridge._impl = seatNotify;
  registerOptimisticSeatAssignedAlertHandler((payload) =>
    seatNotify.showOptimisticSeatAssignedAlert(payload)
  );

  async function setDealerStatus(uid, patch = {}) {
    await setLayoutDealerStatus(TOURNAMENT_ID, uid, patch);
  }

  async function applyDealerAttendancePatchesBatched(pairs = []) {
    await applyLayoutDealerAttendancePatchesBatched(TOURNAMENT_ID, pairs);
  }

  layoutDealerMoves = createLayoutDealerMoves({
    TOURNAMENT_ID,
    waitingState,
    getIdentityKey,
    getWaitingIdentity,
    makeUid,
    touchWaiting,
    setDealerStatus,
    getBestDisplayName: layoutGetBestDisplayName,
    removeWaitingEntriesByIdentity
  });

  const layoutDealerAttendanceSync = createLayoutDealerAttendanceSync({
    waitingState,
    eventState,
    EVENT_ID,
    BOX_ID,
    isEmptyPerson,
    getWaitingIdentity,
    getSeatIdentity,
    applyDealerAttendancePatchesBatched
  });

  layoutHealUndo = createLayoutHealUndo({
    ui,
    eventState,
    waitingState,
    clone,
    reconcileLocalState: () => layoutLocalStateReconcile.reconcileLocalState(),
    saveEventState,
    saveWaitingState,
    syncCurrentEventUserTruth: () => layoutDealerAttendanceSync.syncCurrentEventUserTruth(),
    syncStatusesFromCurrentState: () => layoutDealerAttendanceSync.syncStatusesFromCurrentState(),
    canManageLayout,
    onAfterUndo: () => render()
  });

  function startTick() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      layoutTimers.updateTimers();
    }, 1000);
  }

  /**
   * PWA를 백그라운드에 둔 채 알림(client.navigate)으로 다른 이벤트/대회로 이동시키려는
   * 시도가 실패·부분 반영되면, 화면은 예전 tournamentId/eventId/boxId 로 초기화된 채로
   * 남아 좌석·대기 명단이 전부 비어 보인다(강제 종료 후 재실행하면 정상화되는 이유).
   * 포그라운드로 돌아올 때마다 실제 주소창 파라미터와 비교해 다르면 새로고침해 복구한다.
   */
  function reloadIfLayoutRouteParamsChanged() {
    const params = new URLSearchParams(location.search);
    const urlTournamentId = params.get("tournamentId");
    const urlEventId = params.get("eventId");
    const urlBoxId = params.get("boxId");
    const changed =
      (urlTournamentId && urlTournamentId !== TOURNAMENT_ID) ||
      (urlEventId && urlEventId !== EVENT_ID) ||
      (urlBoxId && urlBoxId !== BOX_ID);
    if (changed) {
      location.reload();
      return true;
    }
    return false;
  }

  /**
   * 모바일 PWA 는 백그라운드에 오래 머물면 onSnapshot 연결이 끊긴 채 복귀하는 경우가 있어
   * (배치 알림 layout_notifications 실시간 구독 포함), "확인" 을 누른 뒤 새로 배치돼도
   * 알림 모달이 다시 뜨지 않는 원인이 된다. 포그라운드 복귀 시 route 변경이 없으면
   * 최소한 getDoc 으로 한 번 더 직접 확인해 놓친 알림을 잡아준다.
   */
  function recheckLayoutOnResume() {
    if (reloadIfLayoutRouteParamsChanged()) return;
    void seatNotify.showPendingSeatNotificationOnce();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (timerHandle) {
        clearInterval(timerHandle);
        timerHandle = null;
      }
      return;
    }
    recheckLayoutOnResume();
    if (!timerHandle) startTick();
  });
  window.addEventListener("pageshow", recheckLayoutOnResume);
  window.addEventListener("focus", recheckLayoutOnResume);

  ({ scheduleLayoutRealtimeUi } = createLayoutRealtimeUi({
    render,
    renderPanel,
    layoutTimers,
    layoutHealUndo
  }));

  const layoutBootstrap = createLayoutBootstrap({
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    refreshCachedEventCardTitle,
    loadEventStateRemote,
    loadEventStateFromGlobalSeats,
    loadWaitingStateRemote,
    eventState,
    waitingState,
    isEmptyPerson,
    normalizeWaitingEntry,
    getIsAdminUser: () => isAdminUser,
    saveEventState,
    saveWaitingState,
    layoutHealUndo,
    layoutViewport,
    layoutGlobalSeatsMerge,
    layoutRealtime,
    render,
    startTick,
    seatNotify,
    scheduleLayoutRealtimeUi
  });

  function bindLayoutPushUiOnce() {
    if (!enablePushBtn || enablePushBtn.dataset.layoutPushBound === "1") return;
    enablePushBtn.dataset.layoutPushBound = "1";
    enablePushBtn.addEventListener("click", async () => {
      const u = currentUser ?? auth.currentUser;
      if (!u?.uid) {
        alert("로그인을 확인하는 중입니다. 잠시 후 다시 눌러 주세요.");
        return;
      }
      const r = await registerFcmWebPushAndSave(u.uid);
      alertFcmRegistrationResult(r);
      syncPushOfferButton(enablePushBtn, u.uid);
    });
  }

  bindLayoutPushUiOnce();

  const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
  void ensureForegroundFcmBadgeListener();

  setupLayoutMainDomWiring({
    menuBtn,
    backBtn,
    pcPanel,
    mobileSheet,
    mobileAddSeatBtn,
    mobileAddWaitingBtn,
    tabs,
    isMobile,
    TOURNAMENT_ID,
    canManageLayout,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    ui,
    render,
    renderPanel,
    layoutTimers,
    seatNotify
  });

  let layoutSessionUid = "";

  onAuthStateChanged(auth, async (user) => {
  if (!user) {
    layoutSessionUid = "";
    currentUser = null;
    currentUserProfile = null;
    isAdminUser = false;

    disposeMyUserProfileRealtime();
    seatNotify.stopNotificationWatch();
    seatNotify.resetSeatNotificationUi();
    location.href = "./login.html";
    return;
  }

  if (isSameAuthSession(layoutSessionUid, user)) {
    currentUser = user;
    void bootstrapAppPush(user.uid);
    return;
  }

  layoutSessionUid = user.uid;

  if (!hasValidLayoutRouteContext()) {
    alert("레이아웃 진입 정보가 올바르지 않아 이벤트 목록으로 이동합니다.");
    if (TOURNAMENT_ID) {
      sessionStorage.setItem("tournamentId", TOURNAMENT_ID);
      location.href = `./index.html?tournamentId=${encodeURIComponent(TOURNAMENT_ID)}`;
    } else {
      location.href = "./hub.html";
    }
    return;
  }

  currentUser = user;
  currentUserProfile = readBootUserProfile(user);
  seedMyUserProfileCache(currentUserProfile);
  applyLayoutOpsPermissions();

  markPageBootLoaded(app);
  if (layoutUi) {
    render();
    renderPanel();
  }

  bindMyUserProfileRealtime(user.uid, {
    email: user.email || "",
    onProfileChange: (profile, meta) => {
      currentUserProfile = profile;
      applyLayoutOpsPermissions(meta);
    }
  });

  syncPushOfferButton(enablePushBtn, user.uid);
  void bootstrapAppPush(user.uid);
  flushAppBadgeIfVisible();

  seatNotify.bindMyNotificationWatch();

  try {
    const profilePromise = raceFirestoreTimeout(layoutLoadMyUserProfile(TOURNAMENT_ID), 10000);
    const bootstrapPromise = raceFirestoreTimeout(layoutBootstrap.init(), 15000);

    void profilePromise.then((profile) => {
      if (profile) {
        currentUserProfile = profile;
        seedMyUserProfileCache(profile);
        applyLayoutOpsPermissions();
        if (layoutUi) {
          render();
          renderPanel();
        }
      }
    });

    await bootstrapPromise;
    const profile = await profilePromise.catch(() => null);
    if (profile && !currentUserProfile) {
      currentUserProfile = profile;
      seedMyUserProfileCache(profile);
    }
    applyLayoutOpsPermissions();
    if (layoutUi) {
      render();
      renderPanel();
    }
  } catch (err) {
    console.error("layout auth init error:", err);
    alert("배치 화면을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    if (layoutUi) render();
  }

  requestAnimationFrame(() => {
    void seatNotify.showPendingSeatNotificationOnce();
  });
});
})();
