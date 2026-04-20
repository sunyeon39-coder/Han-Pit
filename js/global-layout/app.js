import { auth, db } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL, initGlFromUrl, initGlDomRefs } from "./state.js";
import { getIsAdmin } from "./utils.js";
import {
  updateCanvasSeatTimerClasses,
  renderSeatPanel,
  renderWaiting,
  setPanelOpen,
  isTypingInPanel
} from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { bindRealtime } from "./realtime.js";
import { bindGlobalLayoutEventHandlers } from "./ui-events.js";
import {
  registerFcmWebPushAndSave,
  refreshFcmTokenIfGranted,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";

function bindGlobalLayoutPushUiOnce() {
  const btn = GL.enablePushBtn;
  if (!btn || btn.dataset.glPushBound === "1") return;
  btn.dataset.glPushBound = "1";
  btn.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (!u?.uid) return;
    const r = await registerFcmWebPushAndSave(u.uid);
    if (r.ok) {
      alert("백그라운드 알림이 켜졌습니다.");
    } else if (r.reason === "denied") {
      alert("알림이 차단되어 있습니다. 기기 설정에서 이 브라우저의 알림을 허용해 주세요.");
    } else if (r.reason === "not_granted") {
      alert("알림 권한을 허용해 주세요.");
    } else if (r.reason === "unsupported") {
      alert("이 환경에서는 웹 푸시를 사용할 수 없습니다. (HTTPS 또는 localhost 필요)");
    } else {
      alert("알림 설정에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
    syncPushOfferButton(btn, u.uid);
  });
}

export function startGlobalLayoutApp() {
  initGlFromUrl();
  initGlDomRefs();
  bindGlobalLayoutPushUiOnce();
  bindGlobalLayoutEventHandlers();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      location.replace("./login.html");
      return;
    }

    try {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      const profile = userSnap.exists() ? (userSnap.data() || {}) : null;
      GL.isAdminUser = getIsAdmin(user, profile);
      if (!GL.isAdminUser) {
        alert("관리자만 접근할 수 있습니다.");
        location.replace("./index.html");
        return;
      }
      if (GL.urlEventId && GL.urlBoxId) {
        sessionStorage.setItem("eventId", GL.urlEventId);
        sessionStorage.setItem("boxId", GL.urlBoxId);
      }
      syncPushOfferButton(GL.enablePushBtn, user.uid);
      void refreshFcmTokenIfGranted(user.uid);

      setPanelOpen(false);
      bindRealtime();
      updateGlobalMetaToolbar();
      if (GL.timerHandle) clearInterval(GL.timerHandle);
      GL.timerHandle = setInterval(() => {
        if (isTypingInPanel()) return;
        updateCanvasSeatTimerClasses();
        if (GL.activeTab === "seat") {
          renderSeatPanel();
        } else {
          renderWaiting(getCurrentTournamentWaiting());
        }
      }, 1000);
    } catch (err) {
      console.error("global layout init error:", err);
      alert("통합 배치도를 불러오지 못했습니다.");
    }
  });
}
