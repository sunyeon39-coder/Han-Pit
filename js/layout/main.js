import { auth, db } from "../firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { isAdminEmail } from "../app_config.js";
import { escapeHtml } from "../shared/dom-utils.js";
import { createLayoutPersistServices } from "./layout-persist.js";
import {
  setLayoutDealerStatus,
  applyLayoutDealerAttendancePatchesBatched
} from "./dealer-attendance-remote.js";
import { createLayoutSeatNotifyController } from "./seat-notify-controller.js";
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
import { getWaitingTimerStartMs } from "./layout-main-waiting-time.js";
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
import { setupLayoutMainDomWiring } from "./layout-main-dom-wiring.js";
import {
  alertFcmRegistrationResult,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  refreshFcmTokenIfGranted,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";

(() => {
  "use strict";

  const app = document.getElementById("app");
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
  const attendanceWaitingState = { items: [] };
  const {
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    EVENT_DOC_ID,
    LAYOUT_CANVAS_VIEW_KEY,
    EVENT_REF,
    WAITING_REF,
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

  async function undoLastAction() {
    return layoutHealUndo.undoLastAction();
  }

  function render() {
    if (!layoutUi) return;
    layoutUi.render();
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
    waitingRef: WAITING_REF,
    eventState,
    waitingState,
    clone,
    sanitizeLayoutState,
    isEmptyPerson,
    hasWritableLayoutContext
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
    getAttendanceWaiting: () => attendanceWaitingState.items
  });

  const {
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    assignWaitingToSeat,
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
    onAfterGlobalSeatsSnapshot: (merged) => {
      if (merged) void layoutHealUndo.healAndPersistState("global_seats_merge");
      render();
      layoutTimers.updateTimers();
      renderPanel();
    }
  });

  const layoutRealtime = createLayoutRealtimeBind({
    EVENT_REF,
    WAITING_REF,
    TOURNAMENT_ID,
    attendanceWaitingState,
    eventState,
    waitingState,
    EVENT_ID,
    BOX_ID,
    normalizeWaitingEntry,
    applyGlobalSeatMapToEventSeats: () => layoutGlobalSeatsMerge.applyGlobalSeatMapToEventSeats(),
    onAfterEventRemoteSnapshot: () => {
      render();
      void layoutHealUndo.healAndPersistState("event_snapshot");
    },
    onAfterWaitingRemoteSnapshot: () => {
      render();
      void layoutHealUndo.healAndPersistState("waiting_snapshot");
    },
    onAfterAttendanceRemoteSnapshot: () => {
      render();
      void layoutHealUndo.healAndPersistState("attendance_snapshot");
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
    sortWaitingAscending,
    seatCanvasDigitsOnly,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    assignWaitingToSeat,
    undoLastAction,
    isSeatMine: (seat) => isSeatAssignedToCurrentUser(seat, currentUser, currentUserProfile),
    onFullRender: () => render(),
    onPanelRefresh: () => renderPanel(),
    onTimersUpdate: () => layoutTimers.updateTimers()
  });

  const layoutCanvas = createLayoutCanvasBuild({
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
    onFullRender: () => render()
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

  async function loadWaitingStateRemote() {
    return layoutLoadWaitingStateRemote(WAITING_REF);
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
    timerHandle = setInterval(() => layoutTimers.updateTimers(), 1000);
  }

  const layoutBootstrap = createLayoutBootstrap({
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    refreshCachedEventCardTitle,
    loadEventStateRemote,
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
    seatNotify
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

  onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentUserProfile = null;
    isAdminUser = false;

    seatNotify.stopNotificationWatch();
    seatNotify.resetSeatNotificationUi();
    location.href = "./login.html";
    return;
  }

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
  currentUserProfile = await loadMyUserProfile();
  isAdminUser =
    currentUserProfile?.role === "admin" ||
    isAdminEmail(user.email || "");

  syncPushOfferButton(enablePushBtn, user.uid);
  void refreshFcmTokenIfGranted(user.uid);
  flushAppBadgeIfVisible();

  seatNotify.bindMyNotificationWatch();

  await layoutBootstrap.init();

  await seatNotify.showPendingSeatNotificationOnce();
  render();
});
})();
