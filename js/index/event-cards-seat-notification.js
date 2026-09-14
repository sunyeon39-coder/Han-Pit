import { db } from "../firebase.js";
import { doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import {
  buildSeatAssignedNotifyMessage,
  resolveSeatNotificationCardLabel
} from "../shared/seat-notification-label.js";
import {
  isStaleSeatNotification,
  isSeatNotificationPastSettleWindow,
  seatNotificationDelayMs,
  seatNotificationKey,
  SEAT_SWAP_SETTLE_MS
} from "../shared/seat-notification-push.js";
import {
  buildOptimisticSeatAlertKey,
  markOptimisticSeatAlertShown,
  registerOptimisticSeatAssignedAlertHandler,
  shouldSkipSeatNotificationSnapshotAfterOptimistic,
  shouldUseOptimisticSeatAlertOnMobile,
  wasOptimisticSeatAlertShown
} from "../shared/optimistic-seat-assigned-notify.js";
import { IX } from "./state.js";
import { scheduleIndexCardsRender } from "./index-realtime-ui.js";

function cardIdForSeatNotification(data = {}) {
  const eventId = String(data.eventId || "").trim();
  const fromEvents = IX.events.find((e) => e.id === eventId);
  const cardIdFromList = fromEvents
    ? getEventCardIdFromRecord(fromEvents)
    : "";
  return resolveSeatNotificationCardLabel({
    eventId,
    eventTitle: String(data.eventTitle || "").trim(),
    cardId: cardIdFromList
  });
}

let stopSeatAssignmentResumeRecheck = null;

export function bindMySeatAssignment(user) {
  if (!user) return;

  if (IX.stopMySeatNotificationWatch) {
    IX.stopMySeatNotificationWatch();
    IX.stopMySeatNotificationWatch = null;
  }
  if (stopSeatAssignmentResumeRecheck) {
    stopSeatAssignmentResumeRecheck();
    stopSeatAssignmentResumeRecheck = null;
  }

  const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";
  let seatModalAudioCtx = null;
  let seatModalAudioUnlocked = false;
  let seatModalAudioTimer = null;
  let activeSeatNotificationId = "";
  let pendingRevealTimer = null;
  let pendingSettleTimer = null;

  /** 배치 알림 진동 — 소리와 함께 (미지원 브라우저/데스크톱에서는 무시됨) */
  const SEAT_MODAL_VIBRATE_PATTERN = [400, 200, 400];
  function pulseSeatModalVibration() {
    try {
      navigator.vibrate?.(SEAT_MODAL_VIBRATE_PATTERN);
    } catch {
      /* noop */
    }
  }
  function stopSeatModalVibration() {
    try {
      navigator.vibrate?.(0);
    } catch {
      /* noop */
    }
  }

  function stopSeatModalSoundLoop() {
    if (seatModalAudioTimer) {
      clearInterval(seatModalAudioTimer);
      seatModalAudioTimer = null;
    }
    stopSeatModalVibration();
  }

  function hasSavedSoundPreference() {
    try {
      return localStorage.getItem(SOUND_ENABLED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function ensureSeatModalAudioContext() {
    if (seatModalAudioCtx) return seatModalAudioCtx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    seatModalAudioCtx = new AudioCtx();
    return seatModalAudioCtx;
  }

  async function unlockSeatModalAudio() {
    if (seatModalAudioUnlocked) return true;
    const ctx = ensureSeatModalAudioContext();
    if (!ctx) return false;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      seatModalAudioUnlocked = true;
      return true;
    } catch (err) {
      console.error("unlockSeatModalAudio error:", err);
      return false;
    }
  }

  function playSeatModalBeep() {
    const ctx = ensureSeatModalAudioContext();
    if (!ctx) return false;
    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
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
      console.error("playSeatModalBeep error:", err);
      return false;
    }
  }

  async function startSeatModalSoundLoop() {
    const ok = await unlockSeatModalAudio();
    if (!ok) return;
    playSeatModalBeep();
    if (!hasSavedSoundPreference()) return;
    stopSeatModalSoundLoop();
    pulseSeatModalVibration();
    seatModalAudioTimer = setInterval(() => {
      playSeatModalBeep();
      pulseSeatModalVibration();
    }, 1000);
  }

  ["click", "touchstart", "keydown"].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        void unlockSeatModalAudio();
      },
      { once: true }
    );
  });

  function hideSeatAssignmentModal() {
    const overlay = document.getElementById("seatAssignmentModal");
    overlay?.classList.remove("show");
    stopSeatModalSoundLoop();
  }

  function ensureSeatAssignmentModalUi() {
    let overlay = document.getElementById("seatAssignmentModal");

    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "seatAssignmentModal";
    overlay.className = "modal-backdrop";
    overlay.innerHTML = `
    <div class="modal-card">
      <h2>배치 알림</h2>
      <p id="seatAssignmentMessage" style="line-height:1.6; margin:0 0 18px;"></p>
      <div class="modal-actions">
        <button id="seatAssignmentOkBtn" class="btn primary" type="button">확인</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);

    return overlay;
  }

  async function showSeatAssignmentModal({ message = "", uid = "" }) {
    const overlay = ensureSeatAssignmentModalUi();
    const msg = document.getElementById("seatAssignmentMessage");
    const okBtn = document.getElementById("seatAssignmentOkBtn");

    if (msg) {
      msg.textContent = message || "Seat에 배치되었습니다.";
    }

    overlay.classList.add("show");
    void overlay.offsetHeight;
    // 모달이 뜨는 순간 최소 한 번은 진동 (소리 미설정 사용자도 체감되도록)
    pulseSeatModalVibration();
    void startSeatModalSoundLoop();

    const acknowledge = async () => {
      if (!uid) return;
      try {
        await setDoc(
          doc(db, "layout_notifications", uid),
          {
            acknowledged: true,
            acknowledgedAt: Date.now(),
            updatedAt: Date.now()
          },
          { merge: true }
        );
      } catch (err) {
        console.error("ack seat notification error:", err);
      }
    };

    if (okBtn) {
      okBtn.onclick = async () => {
        hideSeatAssignmentModal();
        await acknowledge();
        scheduleIndexCardsRender();
      };
    }
  }

  function showOptimisticSeatAssignmentAlert({
    uid = "",
    eventId = "",
    boxId = "",
    seatId = "",
    seatLabel = "",
    eventTitle = "",
    targetUrl = ""
  } = {}) {
    if (!shouldUseOptimisticSeatAlertOnMobile()) return false;

    const myUid = String(user.uid || "").trim();
    const assigneeUid = String(uid || "").trim();
    if (!myUid || !assigneeUid || assigneeUid !== myUid) return false;

    const sid = String(seatId || "").trim();
    if (!sid) return false;

    const ev = String(eventId || "").trim();
    const bx = String(boxId || "").trim();
    const optKey = buildOptimisticSeatAlertKey({ uid: myUid, eventId: ev, boxId: bx, seatId: sid });
    if (wasOptimisticSeatAlertShown(optKey) || activeSeatNotificationId === optKey) return false;

    markOptimisticSeatAlertShown(optKey);
    activeSeatNotificationId = optKey;

    const cardLabel =
      eventTitle ||
      cardIdForSeatNotification({ eventId: ev, eventTitle });

    IX.currentSeatAssignment = {
      eventId: ev,
      boxId: bx,
      seatId: sid,
      seatLabel: String(seatLabel || "").trim(),
      eventTitle: cardLabel,
      targetUrl: String(targetUrl || "").trim(),
      acknowledged: false
    };
    scheduleIndexCardsRender();

    void showSeatAssignmentModal({
      message: buildSeatAssignedNotifyMessage({
        eventId: ev,
        eventTitle: cardLabel,
        cardId: cardLabel,
        seatLabel
      }),
      uid: myUid
    });
    // 본인이 직접 배치한 경우(낙관적 알림) — layout_notifications 쪽 스냅샷은
    // shouldSkipSeatNotificationSnapshotAfterOptimistic 로 건너뛰어 scheduleAutoDismiss가
    // 안 걸리므로, 여기서 직접 걸어줘야 10분 뒤 자동으로 닫힌다.
    scheduleAutoDismiss({ createdAt: Date.now() });
    return true;
  }

  registerOptimisticSeatAssignedAlertHandler(showOptimisticSeatAssignmentAlert);

  function clearPendingRevealTimer() {
    if (pendingRevealTimer) {
      clearTimeout(pendingRevealTimer);
      pendingRevealTimer = null;
    }
  }

  function clearPendingSettleTimer() {
    if (pendingSettleTimer) {
      clearTimeout(pendingSettleTimer);
      pendingSettleTimer = null;
    }
  }

  /** 모달이 뜬 뒤, 교대 구간(SEAT_SWAP_SETTLE_MS)이 끝나면 확인 없이도 자동으로 닫는다 */
  function scheduleAutoDismiss(data) {
    clearPendingSettleTimer();
    if (isSeatNotificationPastSettleWindow(data)) {
      hideSeatAssignmentModal();
      return;
    }
    const createdMs = Number(data.createdAt);
    if (!Number.isFinite(createdMs) || createdMs <= 0) return;
    const remaining = createdMs + SEAT_SWAP_SETTLE_MS - Date.now();
    pendingSettleTimer = setTimeout(() => {
      pendingSettleTimer = null;
      hideSeatAssignmentModal();
    }, Math.max(0, remaining) + 250);
  }

  function applySeatAssignmentSnap(snap) {
    clearPendingRevealTimer();

    if (!snap.exists()) {
      IX.currentSeatAssignment = null;
      hideSeatAssignmentModal();
      clearPendingSettleTimer();
      scheduleIndexCardsRender();
      return;
    }

    const data = snap.data() || {};
    if (data.type !== "seat_assigned") {
      IX.currentSeatAssignment = null;
      hideSeatAssignmentModal();
      clearPendingSettleTimer();
      scheduleIndexCardsRender();
      return;
    }

    if (data.acknowledged !== true) {
      // notifyAt(교대 공개 시점, REVEAL) 전에는 배지·모달 모두 아직 보여주지 않는다.
      const delayMs = seatNotificationDelayMs(data);
      if (delayMs > 0) {
        pendingRevealTimer = setTimeout(() => {
          pendingRevealTimer = null;
          void refetchAndApply();
        }, delayMs + 250);
        return;
      }
    }

    const eventCardLabel = cardIdForSeatNotification(data);

    IX.currentSeatAssignment = {
      eventId: String(data.eventId || "").trim(),
      boxId: String(data.boxId || "").trim(),
      seatId: String(data.seatId || "").trim(),
      seatLabel: String(data.seatLabel || "").trim(),
      eventTitle: eventCardLabel,
      targetUrl: String(data.targetUrl || "").trim(),
      acknowledged: data.acknowledged === true
    };

    scheduleIndexCardsRender();

    if (data.acknowledged !== true) {
      const notificationKey = seatNotificationKey(user.uid, data);
      const createdMs = Number(data.createdAt);

      if (isStaleSeatNotification(createdMs)) {
        if (activeSeatNotificationId !== notificationKey) {
          hideSeatAssignmentModal();
        }
        activeSeatNotificationId = notificationKey;
        clearPendingSettleTimer();
        return;
      }

      if (activeSeatNotificationId && activeSeatNotificationId !== notificationKey) {
        hideSeatAssignmentModal();
      }

      if (activeSeatNotificationId === notificationKey) return;

      if (
        shouldSkipSeatNotificationSnapshotAfterOptimistic({
          activeNotificationId: activeSeatNotificationId,
          uid: user.uid,
          eventId: data.eventId,
          boxId: data.boxId,
          seatId: data.seatId
        })
      ) {
        activeSeatNotificationId = notificationKey;
        return;
      }

      activeSeatNotificationId = notificationKey;

      const message = buildSeatAssignedNotifyMessage({
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        cardId: eventCardLabel,
        seatLabel: data.seatLabel
      });

      if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) {
        void showSeatAssignmentModal({
          message,
          uid: user.uid
        });
      }
      scheduleAutoDismiss(data);
    } else {
      hideSeatAssignmentModal();
      clearPendingSettleTimer();
    }
  }

  async function refetchAndApply() {
    try {
      const snap = await getDoc(ref);
      applySeatAssignmentSnap(snap);
    } catch (err) {
      console.error("bindMySeatAssignment refetch error:", err);
    }
  }

  const ref = doc(db, "layout_notifications", user.uid);

  IX.stopMySeatNotificationWatch = onSnapshot(
    ref,
    (snap) => {
      applySeatAssignmentSnap(snap);
    },
    (err) => {
      console.error("bindMySeatAssignment error:", err);
    }
  );

  // notifyAt 지연·탭 백그라운드 때문에 공개 시점에 모달을 못 띄운 경우, 다시 포그라운드로
  // 돌아오면 한 번 더 확인해서 놓친 알림을 잡아준다.
  function recheckOnResume() {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    void refetchAndApply();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", recheckOnResume);
    window.addEventListener("focus", recheckOnResume);
    window.addEventListener("pageshow", recheckOnResume);
    stopSeatAssignmentResumeRecheck = () => {
      document.removeEventListener("visibilitychange", recheckOnResume);
      window.removeEventListener("focus", recheckOnResume);
      window.removeEventListener("pageshow", recheckOnResume);
    };
  }
}
