import { auth, db } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL, initGlFromUrl, initGlDomRefs } from "./state.js";
import { getIsAdmin } from "./utils.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import {
  updateCanvasSeatTimerClasses,
  renderSeats,
  renderSeatPanel,
  renderWaiting,
  updateWaitingTimersInPanel,
  setPanelOpen,
  isTypingInPanel
} from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { bindRealtime } from "./realtime.js";
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
  initGlFromUrl();
  initGlDomRefs();
  initGlobalLayoutZoomBarDom();
  wireGlobalLayoutZoomBarOnce();
  bindGlobalLayoutPushUiOnce();
  bindGlobalLayoutEventHandlers();
  const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
  void ensureForegroundFcmBadgeListener();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      location.replace("./login.html");
      return;
    }

    try {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      const profile = userSnap.exists() ? (userSnap.data() || {}) : null;
      GL.userProfile = profile || {};
      GL.isAdminUser = getIsAdmin(user, profile);
      if (!GL.isAdminUser) {
        alert("관리자만 접근할 수 있습니다.");
        location.replace("./index.html");
        return;
      }
      syncGlobalLayoutMobileChrome();
      if (GL.urlEventId && GL.urlBoxId) {
        sessionStorage.setItem("eventId", GL.urlEventId);
        sessionStorage.setItem("boxId", GL.urlBoxId);
      }
      syncPushOfferButton(GL.enablePushBtn, user.uid);
      void refreshFcmTokenIfGranted(user.uid);
      flushAppBadgeIfVisible();

      setPanelOpen(false);
      bindRealtime();
      updateGlobalMetaToolbar();
      if (GL.timerHandle) clearInterval(GL.timerHandle);
      GL.timerHandle = setInterval(() => {
        if (isTypingInPanel()) return;
        if (layoutIsMobile()) {
          renderSeats(GL.globalSeats);
          return;
        }
        updateCanvasSeatTimerClasses();
        if (GL.activeTab === "seat") {
          renderSeatPanel();
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
