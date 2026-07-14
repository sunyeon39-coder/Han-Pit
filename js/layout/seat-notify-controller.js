import { escapeHtml } from "../shared/dom-utils.js";
import { buildSeatAssignedNotifyMessage } from "../shared/seat-notification-label.js";
import {
  buildOptimisticSeatAlertKey,
  markOptimisticSeatAlertShown,
  shouldSkipSeatNotificationSnapshotAfterOptimistic,
  shouldUseOptimisticSeatAlertOnMobile,
  wasOptimisticSeatAlertShown
} from "../shared/optimistic-seat-assigned-notify.js";
import { buildSeatNotifyTag, seatNotificationKey } from "../shared/seat-notification-push.js";
import { db, getMessagingSafe } from "../firebase.js";
import {
  FCM_VAPID_KEY,
  getOrRegisterFcmServiceWorker,
  saveUserFcmToken as saveUserFcmTokenShared
} from "../shared/fcm-web-push.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";

/**
 * 레이아웃 페이지: 좌석 배치 알림(오버레이·반복 비프·브라우저 알림) 및
 * layout_notifications 스냅샷 구독을 한곳에서 관리합니다.
 */
export function createLayoutSeatNotifyController({
  soundEnabledKey,
  alertVolume,
  vapidKey,
  getCurrentUser,
  acknowledgeNotification
}) {
  let myNotificationRef = null;
  let stopMyNotificationWatch = null;

  let audioUnlocked = false;
  let audioRepeatTimer = null;
  let audioCtx = null;
  let soundPromptShown = false;
  let activeNotificationId = "";

  function hasSavedSoundPreference() {
    try {
      return localStorage.getItem(soundEnabledKey) === "1";
    } catch {
      return false;
    }
  }

  function saveSoundPreference(enabled) {
    try {
      if (enabled) {
        localStorage.setItem(soundEnabledKey, "1");
      } else {
        localStorage.removeItem(soundEnabledKey);
      }
    } catch (err) {
      console.error("saveSoundPreference error:", err);
    }
  }

  function ensureAudioContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;

      if (!audioCtx) {
        audioCtx = new AudioCtx();
      }

      return audioCtx;
    } catch (err) {
      console.error("ensureAudioContext error:", err);
      return null;
    }
  }

  async function unlockAudio() {
    if (audioUnlocked) return true;

    const ctx = ensureAudioContext();
    if (!ctx) {
      audioUnlocked = true;
      return true;
    }

    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 880;
      osc.connect(gain);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);

      audioUnlocked = true;
      return true;
    } catch (err) {
      console.error("unlockAudio error:", err);
      return false;
    }
  }

  function playBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return false;

    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(alertVolume, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      gain.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1046.5, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.36);
      return true;
    } catch (err) {
      console.error("playBeep error:", err);
      return false;
    }
  }

  async function playAlertSound() {
    const ok = await unlockAudio();
    if (!ok) return false;
    return playBeep();
  }

  async function enableSound() {
    const ok = await unlockAudio();
    if (ok) {
      saveSoundPreference(true);
      hideSoundPrompt();
      await playAlertSound();
    }
    return ok;
  }

  function stopAlertSoundLoop() {
    if (audioRepeatTimer) {
      clearInterval(audioRepeatTimer);
      audioRepeatTimer = null;
    }
  }

  async function startAlertSoundLoop() {
    if (!hasSavedSoundPreference()) return;

    await playAlertSound();
    stopAlertSoundLoop();
    audioRepeatTimer = setInterval(() => {
      void playAlertSound();
    }, 1000);
  }

  function ensureOverlayRoot() {
    let root = document.getElementById("overlayRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "overlayRoot";
      document.body.appendChild(root);
    }
    return root;
  }

  function showSoundPrompt() {
    if (document.getElementById("soundPromptOverlay")) return;

    const root = ensureOverlayRoot();
    const overlay = document.createElement("div");
    overlay.id = "soundPromptOverlay";
    overlay.className = "modal-overlay sound-overlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "99999";
    overlay.style.background = "rgba(7, 13, 25, 0.72)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.padding = "16px";
    overlay.innerHTML = `
      <div class="modal-card sound-card">
        <div class="modal-title">알림 소리 활성화</div>
        <div class="modal-actions">
          <button id="soundEnableBtn" class="btn primary">활성화</button>
          <button id="soundCloseBtn" class="btn">닫기</button>
        </div>
      </div>
    `;
    root.appendChild(overlay);

    document.getElementById("soundEnableBtn")?.addEventListener("click", async () => {
      const ok = await enableSound();
      if (!ok) {
        alert("브라우저에서 사운드 활성화에 실패했습니다. 다시 눌러주세요.");
      }
    });

    document.getElementById("soundCloseBtn")?.addEventListener("click", () => {
      hideSoundPrompt();
    });
  }

  function hideSoundPrompt() {
    document.getElementById("soundPromptOverlay")?.remove();
  }

  function showSeatAlert(message, meta = {}) {
    hideSeatAlert();

    const root = ensureOverlayRoot();
    const overlay = document.createElement("div");
    overlay.id = "seatAlertOverlay";
    overlay.className = "modal-backdrop show";

    const targetUrl = String(meta.targetUrl || "").trim();

    overlay.innerHTML = `
    <div class="modal-card">
      <h2>배치 알림</h2>
      <p id="layoutSeatAlertMessage" style="line-height:1.6; margin:0 0 18px;">${escapeHtml(message || "Seat에 배치되었습니다.")}</p>

      <div class="modal-actions">
        ${
          targetUrl
            ? `<button id="seatAlertMoveBtn" class="btn primary">이동</button>`
            : ``
        }
        <button id="seatAlertAcknowledgeBtn" class="btn ghost">확인</button>
      </div>
    </div>
  `;
    root.appendChild(overlay);

    const ackBtn = document.getElementById("seatAlertAcknowledgeBtn");
    const moveBtn = document.getElementById("seatAlertMoveBtn");

    ackBtn?.addEventListener("click", async () => {
      stopAlertSoundLoop();
      hideSeatAlert();
      await acknowledgeNotification();
    });

    moveBtn?.addEventListener("click", () => {
      stopAlertSoundLoop();
      location.href = targetUrl;
    });

    void startAlertSoundLoop();
  }

  function showBrowserNotification(title, body = "", uid = "") {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission !== "granted") return;

      const user = getCurrentUser();
      const tag = buildSeatNotifyTag(uid || user?.uid || "");

      new Notification(title, {
        body,
        tag,
        renotify: true,
        lang: "ko",
        vibrate: [180, 80, 180]
      });
    } catch (err) {
      console.error("showBrowserNotification error:", err);
    }
  }

  function hideSeatAlert() {
    document.getElementById("seatAlertOverlay")?.remove();
  }

  function resetSeatNotificationUi() {
    hideSeatAlert();
    stopAlertSoundLoop();
    activeNotificationId = "";
  }

  function showOptimisticSeatAssignedAlert({
    uid = "",
    eventId = "",
    boxId = "",
    seatId = "",
    seatLabel = "",
    eventTitle = "",
    targetUrl = ""
  } = {}) {
    if (!shouldUseOptimisticSeatAlertOnMobile()) return false;

    const user = getCurrentUser();
    const myUid = String(user?.uid || "").trim();
    const assigneeUid = String(uid || "").trim();
    if (!myUid || !assigneeUid || assigneeUid !== myUid) return false;

    const sid = String(seatId || "").trim();
    if (!sid) return false;

    const ev = String(eventId || "").trim();
    const bx = String(boxId || "").trim();
    const optKey = buildOptimisticSeatAlertKey({ uid: myUid, eventId: ev, boxId: bx, seatId: sid });
    if (wasOptimisticSeatAlertShown(optKey) || activeNotificationId === optKey) return false;

    markOptimisticSeatAlertShown(optKey);
    activeNotificationId = optKey;

    const msg = buildSeatAssignedNotifyMessage({
      eventId: ev,
      eventTitle,
      cardId: eventTitle,
      seatLabel
    });

    showSeatAlert(msg, {
      eventTitle,
      seatLabel,
      targetUrl
    });
    showBrowserNotification("배치 알림", msg, myUid);
    return true;
  }

  function applySeatNotificationSnapshot(snap) {
    const user = getCurrentUser();
    if (!user) {
      resetSeatNotificationUi();
      return;
    }

    if (!snap.exists()) {
      resetSeatNotificationUi();
      return;
    }

    const data = snap.data() || {};

    const shouldShow =
      String(data.type || "").trim() === "seat_assigned" && data.acknowledged !== true;

    if (!shouldShow) {
      resetSeatNotificationUi();
      return;
    }

    const notificationKey = [
      user.uid || "",
      data.createdAt || "",
      data.seatId || "",
      data.eventId || "",
      data.boxId || ""
    ].join("__");

    if (activeNotificationId === notificationKey) return;

    if (
      shouldSkipSeatNotificationSnapshotAfterOptimistic({
        activeNotificationId,
        uid: user.uid,
        eventId: data.eventId,
        boxId: data.boxId,
        seatId: data.seatId
      })
    ) {
      activeNotificationId = notificationKey;
      return;
    }

    activeNotificationId = notificationKey;

    const msg = buildSeatAssignedNotifyMessage({
      eventId: data.eventId,
      eventTitle: data.eventTitle,
      seatLabel: data.seatLabel
    });

    showSeatAlert(msg, {
      eventTitle: data.eventTitle || "",
      seatLabel: data.seatLabel || "",
      targetUrl: data.targetUrl || ""
    });

    /* Android 등: 탭이 보이는 동안(document.hidden=false)에는 이전에 OS 알림을 생략해
       소리·오버레이만 있었음. FCM과 동일 tag 로 한 번만 머물도록 시스템 트레이에도 표시. */
    showBrowserNotification("배치 알림", msg, user.uid);
  }

  async function showPendingSeatNotificationOnce() {
    const user = getCurrentUser();
    if (!user) {
      resetSeatNotificationUi();
      return;
    }

    try {
      const ref = doc(db, "layout_notifications", user.uid);
      const snap = await getDoc(ref);
      applySeatNotificationSnapshot(snap);
    } catch (err) {
      console.error("showPendingSeatNotificationOnce error:", err);
    }
  }

  function bindMyNotificationWatch() {
    if (stopMyNotificationWatch) {
      stopMyNotificationWatch();
      stopMyNotificationWatch = null;
    }

    const user = getCurrentUser();
    if (!user) {
      myNotificationRef = null;
      resetSeatNotificationUi();
      return;
    }

    myNotificationRef = doc(db, "layout_notifications", user.uid);

    stopMyNotificationWatch = onSnapshot(
      myNotificationRef,
      (snap) => {
        applySeatNotificationSnapshot(snap);
      },
      (err) => {
        console.error("bindMyNotificationWatch error:", err);
      }
    );
  }

  function stopNotificationWatch() {
    if (stopMyNotificationWatch) {
      stopMyNotificationWatch();
      stopMyNotificationWatch = null;
    }
    myNotificationRef = null;
  }

  function maybePromptInitialSound({ isAdminUser }) {
    if (!isAdminUser && !audioUnlocked && !soundPromptShown && !hasSavedSoundPreference()) {
      soundPromptShown = true;
      showSoundPrompt();
    }
  }

  return {
    unlockAudio,
    maybePromptInitialSound,
    bindMyNotificationWatch,
    showPendingSeatNotificationOnce,
    showOptimisticSeatAssignedAlert,
    resetSeatNotificationUi,
    stopNotificationWatch
  };
}

/** 레이아웃에서 푸시 토큰만 발급할 때 (저장은 saveLayoutPushToken). */
export async function registerLayoutPushIfPossible(vapidKey = FCM_VAPID_KEY) {
  try {
    if (typeof Notification === "undefined") return null;
    if (Notification.permission === "denied") return null;
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return null;

    const messaging = await getMessagingSafe();
    if (!messaging) return null;

    const registration = await getOrRegisterFcmServiceWorker();
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration
    });

    return token || null;
  } catch (err) {
    console.error("registerPushIfPossible error:", err);
    return null;
  }
}

export async function saveLayoutPushToken(uid, token) {
  if (!uid || !token) return;

  try {
    await saveUserFcmTokenShared(uid, token);
  } catch (err) {
    console.error("savePushToken error:", err);
  }
}
