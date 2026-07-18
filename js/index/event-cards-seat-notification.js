import { db } from "../firebase.js";
import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import {
  buildSeatAssignedNotifyMessage,
  resolveSeatNotificationCardLabel
} from "../shared/seat-notification-label.js";
import { isStaleSeatNotification, seatNotificationKey } from "../shared/seat-notification-push.js";
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

export function bindMySeatAssignment(user) {
  if (!user) return;

  if (IX.stopMySeatNotificationWatch) {
    IX.stopMySeatNotificationWatch();
    IX.stopMySeatNotificationWatch = null;
  }

  const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";
  let seatModalAudioCtx = null;
  let seatModalAudioUnlocked = false;
  let seatModalAudioTimer = null;
  let activeSeatNotificationId = "";

  function stopSeatModalSoundLoop() {
    if (seatModalAudioTimer) {
      clearInterval(seatModalAudioTimer);
      seatModalAudioTimer = null;
    }
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
    seatModalAudioTimer = setInterval(() => {
      playSeatModalBeep();
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
        <button id="seatAssignmentGoBtn" class="btn primary" type="button">이동</button>
        <button id="seatAssignmentOkBtn" class="btn ghost" type="button">확인</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);

    return overlay;
  }

  async function showSeatAssignmentModal({ message = "", targetUrl = "", uid = "" }) {
    const overlay = ensureSeatAssignmentModalUi();
    const msg = document.getElementById("seatAssignmentMessage");
    const goBtn = document.getElementById("seatAssignmentGoBtn");
    const okBtn = document.getElementById("seatAssignmentOkBtn");

    if (msg) {
      msg.textContent = message || "Seat에 배치되었습니다.";
    }

    overlay.classList.add("show");
    void overlay.offsetHeight;
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

    if (goBtn) {
      goBtn.onclick = () => {
        hideSeatAssignmentModal();
        location.href = targetUrl || "./layout.html";
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
      targetUrl: String(targetUrl || "").trim(),
      uid: myUid
    });
    return true;
  }

  registerOptimisticSeatAssignedAlertHandler(showOptimisticSeatAssignmentAlert);

  const ref = doc(db, "layout_notifications", user.uid);

  IX.stopMySeatNotificationWatch = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        IX.currentSeatAssignment = null;
        hideSeatAssignmentModal();
        scheduleIndexCardsRender();
        return;
      }

      const data = snap.data() || {};
      if (data.type !== "seat_assigned") {
        IX.currentSeatAssignment = null;
        hideSeatAssignmentModal();
        scheduleIndexCardsRender();
        return;
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
        const targetUrl = String(data.targetUrl || "").trim();

        if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) {
          void showSeatAssignmentModal({
            message,
            targetUrl,
            uid: user.uid
          });
        }
      } else {
        hideSeatAssignmentModal();
      }
    },
    (err) => {
      console.error("bindMySeatAssignment error:", err);
    }
  );
}
