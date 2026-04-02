import { db, auth, getMessagingSafe } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getToken
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";

(() => {
  "use strict";

  const ADMIN_EMAILS = [
  "sunyeon9501@gmail.com"
];

function isAdminEmail(email = "") {
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

  const app = document.getElementById("app");
  const menuBtn = document.getElementById("menuBtn");
  const backBtn = document.getElementById("backBtn");
  const pcPanel = document.getElementById("pcPanel");
  const panelContent = document.getElementById("panelContent");
  const mobileSheet = document.getElementById("mobileSheet");
  const mobileAddSeatBtn = document.getElementById("mobileAddSeat");
  const mobileAddWaitingBtn = document.getElementById("mobileAddWaiting");
  const tabs = Array.from(document.querySelectorAll(".tab"));

  const isMobile = () => window.innerWidth <= 1180;

  function getParam(name) {
    const params = new URLSearchParams(location.search);
    return params.get(name) || sessionStorage.getItem(name) || "";
  }

  const TOURNAMENT_ID = getParam("tournamentId") || "default";
  const EVENT_ID = getParam("eventId") || "default";
  const BOX_ID = getParam("boxId") || "default";
  const FOCUS_SEAT_ID = getParam("focusSeatId") || "";

  const EVENT_DOC_ID = `${EVENT_ID}__${BOX_ID}`;
  const EVENT_REF = doc(db, "layout_events", EVENT_DOC_ID);
  const WAITING_REF = doc(db, "layout_shared", "global_waiting");
  const LAYOUT_EVENTS_REF = collection(db, "layout_events");

  const VAPID_KEY = "BAZXsr3GQtq_nPLrF7C89mr3ejM7DbS-cBBfWNZzHfcHggNier7C2fbIG0uex3DZl8ykVxbqrli54cCdLkena94";
  const ALERT_VOLUME = 0.4;
  const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

  let currentUser = null;
  let currentUserProfile = null;
  let isAdminUser = false;
  let hasInitialized = false;
  let myNotificationRef = null;

  let audioUnlocked = false;
  let audioRepeatTimer = null;
  let audioCtx = null;
  let soundPromptShown = false;
  let activeNotificationId = "";
  let timerHandle = null;

  let globalSeatOccupancy = [];

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
    dragging: null
  };

  const MIN = 60 * 1000;
  const TH_30 = 30 * MIN;
  const TH_60 = 60 * MIN;
  const TH_90 = 90 * MIN;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function makeUid(prefix = "id") {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isEmptyPerson(p) {
    return !p || p === "비어있음";
  }

  function timerClass(ms) {
    if (ms < TH_30) return "t-green";
    if (ms < TH_60) return "t-yellow";
    if (ms < TH_90) return "t-orange";
    return "t-red";
  }

  function fmtElapsed(ms) {
    ms = Math.max(0, ms | 0);
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function hasSavedSoundPreference() {
    try {
      return localStorage.getItem(SOUND_ENABLED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveSoundPreference(enabled) {
    try {
      if (enabled) {
        localStorage.setItem(SOUND_ENABLED_KEY, "1");
      } else {
        localStorage.removeItem(SOUND_ENABLED_KEY);
      }
    } catch (err) {
      console.error("saveSoundPreference error:", err);
    }
  }

  function getCurrentTournamentId() {
    return (
      new URLSearchParams(location.search).get("tournamentId") ||
      sessionStorage.getItem("tournamentId") ||
      ""
    );
  }

  function getCurrentEventTitle() {
    const hint = document.querySelector(".hint-pill");
    if (hint?.textContent) {
      return hint.textContent.replace(/^EVENT:\s*/i, "").trim();
    }
    return EVENT_ID || "이벤트";
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

  function buildGlobalSeatOccupancy(items) {
    const list = [];

    items.forEach((item) => {
      const data = typeof item.data === "function" ? (item.data() || {}) : (item || {});
      const seats = Array.isArray(data.seats) ? data.seats : [];
      const eventId = String(data.eventId || "").trim();
      const boxId = String(data.boxId || "").trim();

      seats.forEach((seat) => {
        const person = String(seat?.person || "").trim();
        if (!person || person === "비어있음") return;

        const label = seat.label ?? seat.no ?? "?";
        const seatedAt = Number(seat.seatedAt || 0) || Date.now();

        list.push({
          name: person,
          uid: seat.personUid || "",
          email: seat.personEmail || "",
          eventId,
          boxId,
          seatLabel: String(label),
          seatId: String(seat.id || ""),
          seatedAt
        });
      });
    });

    list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return list;
  }

  async function loadGlobalSeatOccupancy() {
    try {
      const snap = await getDocs(LAYOUT_EVENTS_REF);
      globalSeatOccupancy = buildGlobalSeatOccupancy(snap.docs);
      renderPanel();
      updateTimers();
    } catch (err) {
      console.error("loadGlobalSeatOccupancy error:", err);
    }
  }

  async function loadMyUserProfile() {
    if (!auth.currentUser) return null;

    try {
      const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
      if (!snap.exists()) return null;
      return snap.data() || null;
    } catch (err) {
      console.error("loadMyUserProfile error:", err);
      return null;
    }
  }

  async function loadEventStateRemote() {
    try {
      const snap = await getDoc(EVENT_REF);
      if (!snap.exists()) return null;
      return snap.data() || null;
    } catch (err) {
      console.error("loadEventStateRemote error:", err);
      return null;
    }
  }

  async function loadWaitingStateRemote() {
    try {
      const snap = await getDoc(WAITING_REF);
      if (!snap.exists()) return null;
      return snap.data() || null;
    } catch (err) {
      console.error("loadWaitingStateRemote error:", err);
      return null;
    }
  }

  async function saveEventState() {
    try {
      await setDoc(
        EVENT_REF,
        {
          ...clone(eventState),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("saveEventState error:", err);
    }
  }
  

  async function saveWaitingState() {
    try {
      await setDoc(
        WAITING_REF,
        {
          ...clone(waitingState),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("saveWaitingState error:", err);
    }
  }

  async function writeUserNotification(payload) {
    if (!payload?.uid) return;

    try {
      await setDoc(
        doc(db, "layout_notifications", payload.uid),
        {
          ...payload,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("writeUserNotification error:", err);
    }
  }

  async function clearUserSeatNotification(uid, reason = "seat_cleared") {
    if (!uid) return;

    try {
      await setDoc(
        doc(db, "layout_notifications", uid),
        {
          type: reason,
          acknowledged: true,
          seatId: "",
          seatLabel: "",
          eventId: "",
          eventTitle: "",
          boxId: "",
          targetUrl: "",
          message: "",
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("clearUserSeatNotification error:", err);
    }
  }

  async function acknowledgeMyNotification() {
    if (!currentUser) return;

    try {
      await setDoc(
        doc(db, "layout_notifications", currentUser.uid),
        {
          acknowledged: true,
          acknowledgedAt: Date.now(),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("acknowledgeMyNotification error:", err);
    }
  }

  function touchEvent() {
    eventState.updatedAt = Date.now();
    void saveEventState();
  }

  function touchWaiting() {
    waitingState.updatedAt = Date.now();
    void saveWaitingState();
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
    if (!ctx) return false;

    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      audioUnlocked = true;
      saveSoundPreference(true);
      playBeep(0.12);
      return true;
    } catch (err) {
      console.error("unlockAudio error:", err);
      return false;
    }
  }

  function playBeep(duration = 0.25) {
    if (!audioUnlocked) return;

    const ctx = ensureAudioContext();
    if (!ctx) return;

    try {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(ALERT_VOLUME, ctx.currentTime);

      oscillator.connect(gain);
      gain.connect(ctx.destination);

      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      oscillator.stop(ctx.currentTime + duration);
    } catch (err) {
      console.error("playBeep error:", err);
    }
  }

  function playAlertSoundLoop() {
    stopAlertSoundLoop();
    playBeep(0.35);

    audioRepeatTimer = setInterval(() => {
      playBeep(0.2);
    }, 1000);
  }

  function stopAlertSoundLoop() {
    if (audioRepeatTimer) {
      clearInterval(audioRepeatTimer);
      audioRepeatTimer = null;
    }
  }

  function hideSeatAlert() {
    const overlay = document.getElementById("seatAlertOverlay");
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  function ensureSoundPromptUi() {
    if (document.getElementById("soundPromptOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "soundPromptOverlay";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.55);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 99998;
      padding: 20px;
    `;

    overlay.innerHTML = `
      <div style="
        width:min(92vw,420px);
        background:#0f172a;
        color:#fff;
        border-radius:20px;
        padding:24px;
        box-shadow:0 24px 60px rgba(0,0,0,.35);
        border:1px solid rgba(255,255,255,.08);
      ">
        <div style="font-size:22px;font-weight:900;margin-bottom:10px;">알림음 활성화</div>
        <div style="font-size:16px;line-height:1.55;margin-bottom:18px;">
          자리 배치 알림이 왔을 때 소리가 나도록 하려면 아래 버튼을 한 번 눌러주세요.
        </div>
        <button id="enableSoundBtn" style="
          width:100%;
          border:none;
          border-radius:12px;
          padding:14px 16px;
          background:#f59e0b;
          color:#111;
          font-size:15px;
          font-weight:900;
          cursor:pointer;
        ">알림음 활성화</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const btn = document.getElementById("enableSoundBtn");
    btn?.addEventListener("click", async () => {
      const ok = await unlockAudio();

      if (!ok) {
        alert("브라우저에서 알림음 활성화에 실패했습니다.");
        return;
      }

      hideSoundPrompt();

      const alertOpen = document.getElementById("seatAlertOverlay")?.style.display === "flex";
      if (alertOpen) {
        playAlertSoundLoop();
      } else {
        playBeep(0.2);
      }
    });
  }

  function showSoundPrompt() {
    ensureSoundPromptUi();
    const overlay = document.getElementById("soundPromptOverlay");
    if (overlay) overlay.style.display = "flex";
  }

  function hideSoundPrompt() {
    const overlay = document.getElementById("soundPromptOverlay");
    if (overlay) overlay.style.display = "none";
  }

  function ensureAlertUi() {
    if (document.getElementById("seatAlertOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "seatAlertOverlay";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.58);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      padding: 20px;
    `;

    overlay.innerHTML = `
      <div style="
        width:min(92vw,420px);
        background:#0f172a;
        color:#fff;
        border-radius:20px;
        padding:24px;
        box-shadow:0 24px 60px rgba(0,0,0,.35);
        border:1px solid rgba(255,255,255,.08);
      ">
        <div style="font-size:22px;font-weight:900;margin-bottom:10px;">자리 배치 알림</div>
        <div id="seatAlertMessage" style="font-size:16px;line-height:1.5;margin-bottom:18px;"></div>

        <div style="display:flex;gap:10px;flex-direction:column;">
          <button id="seatAlertGoBtn" style="
            width:100%;
            border:none;
            border-radius:12px;
            padding:14px 16px;
            background:#22c55e;
            color:#07111f;
            font-size:15px;
            font-weight:900;
            cursor:pointer;
          ">자리로 이동</button>

          <button id="seatAlertConfirmBtn" style="
            width:100%;
            border:none;
            border-radius:12px;
            padding:14px 16px;
            background:#f59e0b;
            color:#111;
            font-size:15px;
            font-weight:900;
            cursor:pointer;
          ">확인</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const confirmBtn = document.getElementById("seatAlertConfirmBtn");
    confirmBtn?.addEventListener("click", async () => {
      stopAlertSoundLoop();
      hideSeatAlert();
      await acknowledgeMyNotification();
    });

    const goBtn = document.getElementById("seatAlertGoBtn");
    goBtn?.addEventListener("click", async () => {
      if (!currentUser) return;

      try {
        const snap = await getDoc(doc(db, "layout_notifications", currentUser.uid));
        const data = snap.exists() ? (snap.data() || {}) : null;
        const targetUrl = data?.targetUrl || buildSeatTargetUrl(EVENT_ID, BOX_ID);

        stopAlertSoundLoop();
        hideSeatAlert();
        await acknowledgeMyNotification();

        location.href = targetUrl;
      } catch (err) {
        console.error("seatAlertGoBtn error:", err);
      }
    });
  }

  function showSeatAlert(message) {
    ensureAlertUi();

    const overlay = document.getElementById("seatAlertOverlay");
    const msg = document.getElementById("seatAlertMessage");

    if (msg) {
      msg.textContent = message || "Seat에 배치되었습니다.";
    }

    if (overlay) {
      overlay.style.display = "flex";
    }

    if (!audioUnlocked) {
      if (!hasSavedSoundPreference()) {
        showSoundPrompt();
      }
      return;
    }

    playAlertSoundLoop();
  }

  async function registerPushForCurrentUser() {
    if (!currentUser) return;
    if (!("serviceWorker" in navigator)) return;
    if (!("Notification" in window)) return;

    try {
      if (Notification.permission === "denied") {
        alert("알림이 차단되어 있습니다. iPhone 설정에서 다시 허용해주세요.");
        return;
      }

      let permission = Notification.permission;

      if (permission !== "granted") {
        permission = await Notification.requestPermission();
      }

      if (permission !== "granted") {
        console.log("push permission not granted");
        return;
      }

      const swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      const messaging = await getMessagingSafe();
      if (!messaging) return;

      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg
      });

      if (!token) {
        console.warn("FCM token not available");
        return;
      }

      await setDoc(
        doc(db, "users", currentUser.uid),
        {
          fcmWebToken: token,
          pushEnabled: true,
          pushUpdatedAt: Date.now(),
          pushUpdatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      alert("알림이 활성화되었습니다.");
      console.log("FCM token saved:", token);
    } catch (err) {
      console.error("registerPushForCurrentUser error:", err);
      alert("알림 활성화 중 오류가 발생했습니다.");
    }
  }

  function returnPersonToWaiting(name, personUid = "", personEmail = "") {
    const n = String(name || "").trim();
    if (!n) return;

    const exists = waitingState.waiting.some((w) => {
      if (!w || typeof w !== "object") return false;
      if (personUid && w.uid === personUid) return true;
      return false;
    });

    if (exists) return;

    waitingState.waiting.push({
      id: personUid ? `w_${personUid}` : makeUid("w"),
      uid: String(personUid || "").trim(),
      email: String(personEmail || "").trim(),
      name: n,
      addedAt: Date.now()
    });

    touchWaiting();
  }
  function getAttendanceDocId(tournamentId, uid) {
  return `${tournamentId}__${uid}`;
}

function getAttendanceRef(tournamentId, uid) {
  return doc(db, "dealer_attendance", getAttendanceDocId(tournamentId, uid));
}

function getCurrentTournamentIdSafe() {
  return (
    new URLSearchParams(location.search).get("tournamentId") ||
    sessionStorage.getItem("tournamentId") ||
    ""
  );
}

async function setDealerStatus(uid, patch = {}) {
  const tournamentId = getCurrentTournamentIdSafe();
  if (!tournamentId || !uid) return;

  try {
    await setDoc(
      getAttendanceRef(tournamentId, uid),
      {
        uid: String(uid).trim(),
        tournamentId,
        updatedAt: Date.now(),
        ...patch
      },
      { merge: true }
    );
  } catch (err) {
    console.error("setDealerStatus error:", err);
  }
}

async function moveDealerToWaiting({ uid = "", email = "", name = "" }) {
  if (!uid || !name) return;

  returnPersonToWaiting(name, uid, email);

  await setDealerStatus(uid, {
    email: String(email || "").trim(),
    nickname: String(name || "").trim(),
    status: "waiting",
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: ""
  });
}

async function moveDealerToAssigned({
  uid = "",
  email = "",
  name = "",
  seatId = "",
  seatLabel = "",
  eventId = "",
  boxId = ""
}) {
  if (!uid || !name) return;

  waitingState.waiting = waitingState.waiting.filter((w) => {
    if (!w || typeof w !== "object") return false;
    return String(w.uid || "").trim() !== String(uid).trim();
  });
  touchWaiting();

  await setDealerStatus(uid, {
    email: String(email || "").trim(),
    nickname: String(name || "").trim(),
    status: "assigned",
    currentEventId: String(eventId || "").trim(),
    currentBoxId: String(boxId || "").trim(),
    currentSeatId: String(seatId || "").trim(),
    currentSeatLabel: String(seatLabel || "").trim()
  });
}

  function getCanvasRectForSeatPlacement() {
    const canvas = document.querySelector(".pc-canvas");
    if (!canvas) {
      return {
        width: Math.max(window.innerWidth - 420, 700),
        height: Math.max(window.innerHeight - 140, 500)
      };
    }

    return {
      width: canvas.clientWidth || 900,
      height: canvas.clientHeight || 600
    };
  }

  function getNextSeatPosition() {
    const { width, height } = getCanvasRectForSeatPlacement();

    const BOX_W = 180;
    const BOX_H = 84;
    const GAP_X = 20;
    const GAP_Y = 20;
    const PAD = 20;
    const START_Y = 40;

    const usableW = Math.max(width - PAD * 2, BOX_W);
    const cols = Math.max(1, Math.floor((usableW + GAP_X) / (BOX_W + GAP_X)));

    const index = eventState.seats.length;
    const col = index % cols;
    const row = Math.floor(index / cols);

    let x = PAD + col * (BOX_W + GAP_X);
    let y = START_Y + row * (BOX_H + GAP_Y);

    const maxX = Math.max(PAD, width - BOX_W - PAD);
    const maxY = Math.max(PAD, height - BOX_H - PAD);

    x = Math.max(PAD, Math.min(x, maxX));
    y = Math.max(PAD, Math.min(y, maxY));

    return { x, y };
  }

  function promptSeatLabel(defaultLabel) {
    if (!canManageLayout()) return null;

    const msg = `Seat 라벨을 입력하세요 (숫자/영어/원하는 텍스트)\n예: 1, A, VIP, Table1`;
    const input = prompt(msg, defaultLabel);

    if (input === null) return null;

    const v = String(input).trim();
    return v || defaultLabel;
  }

  function addSeat() {
    if (!canManageLayout()) return;

    const id = makeUid("seat");
    const no = eventState.nextSeatNo++;
    const order = eventState.nextSeatOrder++;
    const labelDefault = String(no);
    const label = promptSeatLabel(labelDefault);

    if (label === null) {
      eventState.nextSeatNo--;
      eventState.nextSeatOrder--;
      return;
    }

    const { x, y } = getNextSeatPosition();

    eventState.seats.push({
      id,
      label,
      no,
      order,
      person: "비어있음",
      personUid: "",
      personEmail: "",
      seatedAt: null,
      x,
      y
    });

    touchEvent();
    render();
  }

  function renameSeat(seatId) {
    if (!canManageLayout()) return;

    const s = eventState.seats.find((x) => x.id === seatId);
    if (!s) return;

    const next = promptSeatLabel(String(s.label ?? s.no));
    if (next === null) return;

    s.label = next;
    touchEvent();
    render();
  }

  function deleteSeat(seatId) {
  if (!canManageLayout()) return;

  const idx = eventState.seats.findIndex((s) => s.id === seatId);
  if (idx < 0) return;

  const seat = eventState.seats[idx];
  const prevName = String(seat.person || "").trim();
  const prevUid = String(seat.personUid || "").trim();
  const prevEmail = String(seat.personEmail || "").trim();

  eventState.seats.splice(idx, 1);

  if (ui.selectedSeatId === seatId) ui.selectedSeatId = null;

  if (prevUid) {
    void clearUserSeatNotification(prevUid, "seat_deleted");
  }

  touchEvent();
  render();

  if (prevUid && prevName) {
    void moveDealerToWaiting({
      uid: prevUid,
      email: prevEmail,
      name: prevName
    });
  }
    touchEvent();
    render();
  }

  function clearSeat(seatId) {
  if (!canManageLayout()) return;

  const s = eventState.seats.find((x) => x.id === seatId);
  if (!s) return;

  const prevName = String(s.person || "").trim();
  const prevUid = String(s.personUid || "").trim();
  const prevEmail = String(s.personEmail || "").trim();

  s.person = "비어있음";
  s.personUid = "";
  s.personEmail = "";
  s.seatedAt = null;

  if (prevUid) {
    void clearUserSeatNotification(prevUid, "seat_cleared");
  }

  touchEvent();
  render();

  if (prevUid && prevName) {
    void moveDealerToWaiting({
      uid: prevUid,
      email: prevEmail,
      name: prevName
    });
  }
}

  function addWaiting(name, personUid = "", personEmail = "") {
    if (!canManageLayout()) return;

    const n = String(name || "").trim();
    if (!n) return;

    const exists = waitingState.waiting.some((w) => {
      if (!w || typeof w !== "object") return false;
      if (personUid && w.uid === personUid) return true;
      return false;
    });

    if (exists) return;

    waitingState.waiting.push({
      id: personUid ? `w_${personUid}` : makeUid("w"),
      uid: String(personUid || "").trim(),
      email: String(personEmail || "").trim(),
      name: n,
      addedAt: Date.now()
    });

    touchWaiting();
    render();
  }

  function deleteWaiting(waitingId) {
    if (!canManageLayout()) return;

    const idx = waitingState.waiting.findIndex((w) => w.id === waitingId);
    if (idx >= 0) {
      waitingState.waiting.splice(idx, 1);
      if (ui.selectedWaitingId === waitingId) ui.selectedWaitingId = null;
      touchWaiting();
      render();
    }
  }

  async function assignWaitingToSeat(waitingId, seatId) {
  if (!canManageLayout()) return;

  const wIdx = waitingState.waiting.findIndex((w) => w.id === waitingId);
  const seat = eventState.seats.find((s) => s.id === seatId);
  if (wIdx < 0 || !seat) return;

  const w = waitingState.waiting[wIdx];

  const prevName = String(seat.person || "").trim();
  const prevUid = String(seat.personUid || "").trim();
  const prevEmail = String(seat.personEmail || "").trim();

  seat.person = w.name;
  seat.personUid = w.uid || "";
  seat.personEmail = w.email || "";
  seat.seatedAt = Date.now();

  waitingState.waiting.splice(wIdx, 1);
  ui.selectedWaitingId = null;

  if (prevUid && prevUid !== seat.personUid) {
    await clearUserSeatNotification(prevUid, "seat_reassigned");
  }

  touchWaiting();
  touchEvent();
  render();

  if (prevUid && prevName && prevUid !== seat.personUid) {
    await moveDealerToWaiting({
      uid: prevUid,
      email: prevEmail,
      name: prevName
    });
  }

  if (w.uid && w.name) {
    await moveDealerToAssigned({
      uid: w.uid || "",
      email: w.email || "",
      name: w.name || "",
      seatId: seat.id,
      seatLabel: seat.label ?? seat.no ?? "",
      eventId: EVENT_ID,
      boxId: BOX_ID
    });
  }

  if (w.uid) {
    const seatLabel = String(seat.label ?? seat.no ?? "").trim();
    const eventTitle = getCurrentEventTitle();
    const tournamentId = getCurrentTournamentId();

    await writeUserNotification({
      uid: w.uid,
      type: "seat_assigned",
      acknowledged: false,
      createdAt: Date.now(),
      tournamentId,
      eventId: EVENT_ID,
      eventTitle,
      boxId: BOX_ID,
      seatId: seat.id,
      seatLabel,
      targetUrl: buildSeatTargetUrl(EVENT_ID, BOX_ID, seat.id),
      message: `${eventTitle} / Seat ${seatLabel}에 배치되었습니다.`
    });
  }
}

  function render() {
    app.innerHTML = "";

    if (isMobile()) {
      renderMobile();
    } else {
      renderPC();
    }

    renderPanel();
    updateTimers();
  }

  function renderPC() {
    const canvas = document.createElement("div");
    canvas.className = "canvas pc-canvas";
   canvas.innerHTML = ``;

    app.appendChild(canvas);

    const BOX_W = 180;
    const BOX_H = 84;
    const PAD = 10;

    eventState.seats.forEach((seat) => {
      const maxX = Math.max(PAD, canvas.clientWidth - BOX_W - PAD);
      const maxY = Math.max(PAD, canvas.clientHeight - BOX_H - PAD);

      seat.x = Math.max(PAD, Math.min(Number(seat.x ?? PAD), maxX));
      seat.y = Math.max(PAD, Math.min(Number(seat.y ?? PAD), maxY));

      const el = document.createElement("div");
      el.className = "seat-box" + (ui.selectedSeatId === seat.id ? " selected" : "");
      el.style.left = `${seat.x}px`;
      el.style.top = `${seat.y}px`;
      el.dataset.seatid = seat.id;

      el.innerHTML = `
        <div class="seat-title">Seat ${escapeHtml(seat.label ?? seat.no)}</div>
        <div class="seat-person">
          ${escapeHtml(seat.person)}
        </div>
      `;

            let pointerMoved = false;
      let pointerStartX = 0;
      let pointerStartY = 0;
      let pointerType = "";
      let isPointerDragging = false;

      el.addEventListener("click", async (e) => {
        e.stopPropagation();

        if (pointerType === "touch" || pointerType === "pen") {
          return;
        }

        ui.selectedSeatId = seat.id;

        if (ui.selectedWaitingId && canManageLayout()) {
          await assignWaitingToSeat(ui.selectedWaitingId, seat.id);
          ui.selectedSeatId = null;
          render();
          return;
        }

        render();
      });

      el.addEventListener("pointerdown", (e) => {
        if (!canManageLayout()) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;

        e.stopPropagation();

        pointerType = e.pointerType || "mouse";
        pointerMoved = false;
        isPointerDragging = false;
        pointerStartX = e.clientX;
        pointerStartY = e.clientY;

        const rect = canvas.getBoundingClientRect();
        const pointerX = e.clientX - rect.left;
        const pointerY = e.clientY - rect.top;

        ui.dragging = {
          id: seat.id,
          offsetX: pointerX - seat.x,
          offsetY: pointerY - seat.y
        };

        el.setPointerCapture(e.pointerId);
      });

      el.addEventListener("pointermove", (e) => {
        if (!canManageLayout()) return;
        if (!ui.dragging || ui.dragging.id !== seat.id) return;

        const dx = Math.abs(e.clientX - pointerStartX);
        const dy = Math.abs(e.clientY - pointerStartY);

        if (dx > 8 || dy > 8) {
          pointerMoved = true;
        }

        const shouldDrag = e.pointerType === "mouse" || pointerMoved;
        if (!shouldDrag) return;

        isPointerDragging = true;

        const rect = canvas.getBoundingClientRect();
        const pointerX = e.clientX - rect.left;
        const pointerY = e.clientY - rect.top;

        const s = eventState.seats.find((x) => x.id === seat.id);
        if (!s) return;

        let nextX = pointerX - ui.dragging.offsetX;
        let nextY = pointerY - ui.dragging.offsetY;

        nextX = Math.max(PAD, Math.min(nextX, canvas.clientWidth - BOX_W - PAD));
        nextY = Math.max(PAD, Math.min(nextY, canvas.clientHeight - BOX_H - PAD));

        s.x = nextX;
        s.y = nextY;

        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      });

      el.addEventListener("pointerup", async (e) => {
        if (!canManageLayout()) return;
        if (!ui.dragging || ui.dragging.id !== seat.id) return;

        const wasTap = !isPointerDragging && !pointerMoved;

        ui.dragging = null;

        if (isPointerDragging) {
          touchEvent();
          return;
        }

        if ((e.pointerType === "touch" || e.pointerType === "pen") && wasTap) {
          e.stopPropagation();
          ui.selectedSeatId = seat.id;

          if (ui.selectedWaitingId) {
            await assignWaitingToSeat(ui.selectedWaitingId, seat.id);
            ui.selectedSeatId = null;
          }

          render();
          return;
        }

        render();
      });

      el.addEventListener("pointercancel", () => {
        if (!canManageLayout()) return;
        if (!ui.dragging || ui.dragging.id !== seat.id) return;
        ui.dragging = null;
      });

      canvas.appendChild(el);
    });

    canvas.addEventListener("click", () => {
      ui.selectedSeatId = null;
      render();
    });
  }

  function renderMobile() {
    const wrap = document.createElement("div");
    wrap.className = "mobile";

    const selectedWaiting = waitingState.waiting.find(
      (w) => w.id === ui.selectedWaitingId
    ) || null;

    const seatCard = document.createElement("div");
    seatCard.className = "card";
    seatCard.innerHTML = `
      <div class="mobile-section-head">
        <h3>Seat</h3>
        ${
          canManageLayout()
            ? `<button id="mobileAddSeatInline" class="btn primary">+ Seat 추가</button>`
            : ``
        }
      </div>
    `;

    if (canManageLayout() && selectedWaiting) {
      seatCard.innerHTML += `
        <div class="mobile-selection-banner">
          <span class="badge sel">선택된 대기</span>
          <strong>${escapeHtml(selectedWaiting.name)}</strong>
        </div>
      `;
    }

    if (eventState.seats.length === 0) {
      seatCard.innerHTML += `
        <div class="row">
          <div>Seat</div>
          <div class="muted">없음</div>
        </div>
      `;
    } else {
      eventState.seats
        .slice()
        .sort((a, b) => (a.order ?? a.no) - (b.order ?? b.no))
        .forEach((s) => {
          const hasPerson = !isEmptyPerson(s.person);
          const start = hasPerson ? (s.seatedAt || Date.now()) : null;
          const isSel = ui.selectedSeatId === s.id;

          seatCard.innerHTML += `
            <div class="mobile-seat-row compact ${isSel ? "selected" : ""}" data-mobile-seat="${s.id}">
              <div class="mobile-seat-mainline">
                <div class="mobile-seat-inline">
  <div class="mobile-seat-leftpack">
    <div class="mobile-seat-no-pill">
      ${escapeHtml(s.label ?? s.no)}
    </div>

    <div class="mobile-seat-name ${isEmptyPerson(s.person) ? "is-empty" : ""}">
      ${
        isEmptyPerson(s.person)
          ? `Empty`
          : escapeHtml(s.person)
      }
    </div>
  </div>

  ${
    canManageLayout()
      ? `
      <div class="mobile-seat-inline-actions">
        ${
          hasPerson
            ? `<button class="mobile-pill-btn warn" data-clear-seat="${s.id}">
                비우기
              </button>`
            : ``
        }

        <button class="mobile-pill-btn danger" data-del="${s.id}">
          삭제
        </button>

        ${
          selectedWaiting
            ? `<button class="mobile-pill-btn primary" data-mobile-assign="${s.id}">
                ${escapeHtml(selectedWaiting.name)} 배치
              </button>`
            : ``
        }
      </div>
      `
      : ``
  }
</div>

                <div class="mobile-seat-right">
                  ${
                    hasPerson
                      ? `<span class="time-chip" data-timer="seat" data-start="${start}" data-target="seat:${s.id}">00:00:00</span>`
                      : `<span class="mobile-empty-dash">—</span>`
                  }
                </div>
              </div>
            </div>
          `;
        });
    }

    const waitCard = document.createElement("div");
    waitCard.className = "card";
    waitCard.innerHTML = `
      <div class="mobile-section-head">
        <h3>대기</h3>
        ${
          canManageLayout()
            ? `<button id="mobileAddWaitingInline" class="btn primary">+ 대기 추가</button>`
            : ``
        }
      </div>
    `;

    const sortedWaiting = [...waitingState.waiting].sort((a, b) => {
      const aTime = Number(a?.addedAt || 0);
      const bTime = Number(b?.addedAt || 0);
      return aTime - bTime;
    });

    if (sortedWaiting.length === 0) {
      waitCard.innerHTML += `
        <div class="row">
          <div>대기</div>
          <div class="muted">없음</div>
        </div>
      `;
    } else {
      sortedWaiting.forEach((w) => {
        const start = w.addedAt || Date.now();
        const isSel = ui.selectedWaitingId === w.id;

        waitCard.innerHTML += `
          <div class="mobile-wait-row compact ${isSel ? "selected" : ""}" data-mobile-wait="${w.id}">
            <div class="mobile-wait-mainline">
              <div class="mobile-wait-inline">
                <div class="mobile-wait-name">
                  ${escapeHtml(w.name)}
                </div>

                ${
                  canManageLayout()
                    ? `
                    <div class="mobile-wait-inline-actions">
                     

                      <button class="mobile-pill-btn danger" data-del-w="${w.id}">
                        삭제
                      </button>
                    </div>
                    `
                    : ``
                }
              </div>

              <div class="mobile-wait-right">
                <span class="time-chip" data-timer="wait" data-start="${start}" data-target="wait:${w.id}">
                  00:00:00
                </span>
              </div>
            </div>
          </div>
        `;
      });
    }

    if (canManageLayout()) {
      waitCard.innerHTML += `
        <div class="mobile-selection-status">
          ${
            ui.selectedWaitingId
              ? `<div class="badge sel">대기 선택됨</div>`
              : `<div class="badge">선택된 대기 없음</div>`
          }
          ${
            ui.selectedSeatId
              ? `<div class="badge sel">Seat 선택됨</div>`
              : `<div class="badge">선택된 Seat 없음</div>`
          }
        </div>
      `;
    }

    wrap.append(seatCard, waitCard);
    app.appendChild(wrap);

    if (!canManageLayout()) return;

    const addSeatBtn = document.getElementById("mobileAddSeatInline");
    if (addSeatBtn) {
      addSeatBtn.onclick = () => addSeat();
    }

    const addWaitBtn = document.getElementById("mobileAddWaitingInline");
    if (addWaitBtn) {
      addWaitBtn.onclick = () => {
        const name = prompt("대기자 이름");
        if (name) addWaiting(name);
      };
    }

           wrap.querySelectorAll("[data-mobile-seat]").forEach((row) => {
      row.addEventListener("click", async (e) => {
        if (
          e.target.closest("[data-mobile-seat-select]") ||
          e.target.closest("[data-del]") ||
          e.target.closest("[data-mobile-assign]") ||
          e.target.closest("[data-clear-seat]")
        ) {
          return;
        }

        const sid = row.getAttribute("data-mobile-seat");
        if (!sid) return;

        ui.selectedSeatId = sid;

        if (ui.selectedWaitingId && canManageLayout()) {
          await assignWaitingToSeat(ui.selectedWaitingId, sid);
          ui.selectedSeatId = null;
          render();
          return;
        }

        render();
      });
    });

    wrap.querySelectorAll("[data-mobile-wait]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (
          e.target.closest("[data-mobile-wait-select]") ||
          e.target.closest("[data-del-w]")
        ) {
          return;
        }

        const wid = row.getAttribute("data-mobile-wait");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        render();
      });
    });

    wrap.querySelectorAll("[data-mobile-seat-select]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute("data-mobile-seat-select");
        ui.selectedSeatId = ui.selectedSeatId === sid ? null : sid;
        render();
      });
    });

    wrap.querySelectorAll("[data-mobile-wait-select]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wid = btn.getAttribute("data-mobile-wait-select");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        render();
      });
    });

    wrap.querySelectorAll("[data-mobile-assign]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute("data-mobile-assign");

        if (!ui.selectedWaitingId) {
          alert("먼저 대기자를 선택하세요.");
          return;
        }

        await assignWaitingToSeat(ui.selectedWaitingId, sid);
        ui.selectedSeatId = null;
        render();
      });
    });

    wrap.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSeat(btn.getAttribute("data-del"));
      });
    });

    wrap.querySelectorAll("[data-del-w]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWaiting(btn.getAttribute("data-del-w"));
      });
    });

    wrap.querySelectorAll("[data-clear-seat]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSeat(btn.getAttribute("data-clear-seat"));
      });
    });
  }

  function renderPanel() {
    if (isMobile()) return;

    tabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === ui.activeTab);
    });

    if (ui.activeTab === "wait") {
      renderWaitPanel();
    } else if (ui.activeTab === "seat") {
      renderSeatPanel();
    } else {
      renderBoxPanel();
    }
  }

  function renderWaitPanel() {
    const selected = ui.selectedWaitingId;
    const html = [];

    html.push(`<div class="panel-title">대기 관리 (공유)</div>`);

    if (canManageLayout()) {
      html.push(`<input id="waitNameInput" placeholder="대기자 이름 입력" />`);
      html.push(`<button id="addWaitBtn" class="btn primary" style="width:100%; margin-bottom:12px;">+ 대기 추가</button>`);
    } else {
      html.push(`<div class="badge" style="margin-bottom:12px;">관리 권한은 admin만 가능합니다</div>`);
    }

    if (waitingState.waiting.length === 0) {
      html.push(`
        <div class="row">
          <div class="left">
            <div>대기자 없음</div>
            <div class="badge">오래 기다린 순으로 자동 정렬됩니다</div>
          </div>
        </div>
      `);
    } else {
      const sortedWaitingAll = [...waitingState.waiting].sort((a, b) => {
        const aTime = Number(a?.addedAt || 0);
        const bTime = Number(b?.addedAt || 0);
        return aTime - bTime;
      });

      sortedWaitingAll.forEach((w) => {
        const isSel = selected === w.id;
        const start = w.addedAt || Date.now();

        html.push(`
          <div class="wait-manage-row ${isSel ? "selected" : ""}" data-wid="${w.id}" style="cursor:pointer;">
            <div class="wait-manage-main">
              <div class="wait-manage-inline">
                <div class="wait-manage-name">
                  ${escapeHtml(w.name)}
                </div>

                ${
                  canManageLayout()
                    ? `
                    <div class="wait-inline-actions">
                      

                      <button class="pill-inline danger" type="button" data-del-w="${w.id}">
                        삭제
                      </button>
                    </div>
                    `
                    : ``
                }
              </div>

              <div class="wait-manage-timer">
                <span
                  class="time-chip"
                  data-timer="wait"
                  data-start="${start}"
                  data-target="wait:${w.id}">
                  00:00:00
                </span>
              </div>
            </div>
          </div>
        `);
      });
    }

    panelContent.innerHTML = html.join("");

    const input = document.getElementById("waitNameInput");
    const addBtn = document.getElementById("addWaitBtn");

    if (addBtn && input) {
      addBtn.onclick = () => {
        addWaiting(input.value);
        input.value = "";
        input.focus();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn.click();
      });
    }

    panelContent.querySelectorAll("[data-wid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target && e.target.matches("[data-del-w]")) return;

        const wid = el.getAttribute("data-wid");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        ui.selectedSeatId = null;
        render();
      });
    });

    panelContent.querySelectorAll("[data-del-w]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWaiting(btn.getAttribute("data-del-w"));
      });
    });
  }

  function renderSeatPanel() {
    const html = [];
    const seatedAll = globalSeatOccupancy;
    const waitingAll = waitingState.waiting || [];

    const left = [];
    left.push(`<div class="panel-title">Seat 관리 (이벤트별)</div>`);

    if (canManageLayout()) {
      left.push(`<button id="addSeatBtn" class="btn primary" style="width:100%; margin-bottom:12px;">+ Seat 추가</button>`);
    } else {
      left.push(`<div class="badge" style="margin-bottom:12px;">Seat 관리는 admin만 가능합니다</div>`);
    }

    if (eventState.seats.length === 0) {
      left.push(`
        <div class="row">
          <div class="left">
            <div>Seat 없음</div>
            <div class="badge">현재 이벤트(${escapeHtml(EVENT_ID)})에만 생성됩니다</div>
          </div>
        </div>
      `);
    } else {
      eventState.seats
        .slice()
        .sort((a, b) => (a.order ?? a.no) - (b.order ?? b.no))
        .forEach((s) => {
          const isSel = ui.selectedSeatId === s.id;
          const hasPerson = !isEmptyPerson(s.person);
          const start = hasPerson ? (s.seatedAt || Date.now()) : null;

          left.push(`
            <div class="seat-manage-row ${isSel ? "selected" : ""}" data-sid="${s.id}" style="cursor:pointer;">
              <div class="seat-manage-main">
                <div class="seat-manage-inline">
                  <div class="seat-manage-texts">
                    <div class="seat-manage-title">
                      Seat ${escapeHtml(s.label ?? s.no)}
                    </div>

                    <div class="seat-manage-name ${isEmptyPerson(s.person) ? "is-empty" : ""}">
                      ${escapeHtml(s.person)}
                    </div>
                  </div>

                  ${
                    canManageLayout()
                      ? `
                      <div class="seat-inline-actions">
                        <button class="pill-inline" type="button">
                          선택
                        </button>

                        ${
                          hasPerson
                            ? `<button class="pill-inline warn" data-clear-seat="${s.id}">
                                비우기
                              </button>`
                            : ``
                        }

                        <button class="pill-inline danger" type="button" data-del="${s.id}">
                          삭제
                        </button>
                      </div>
                      `
                      : ``
                  }
                </div>

                <div class="seat-manage-timer">
                  ${
                    hasPerson
                      ? `<span class="time-chip"
                          data-timer="seat"
                          data-start="${start}"
                          data-target="seat:${s.id}">
                          00:00:00
                        </span>`
                      : `<span class="seat-manage-empty-dash">—</span>`
                  }
                </div>
              </div>
            </div>
          `);
        });
    }

    const right = [];
    right.push(`<div class="panel-box">`);
    right.push(`<h4>전역 현황 (대기/배치)</h4>`);
    right.push(`<div class="badge" style="margin-bottom:8px;">대기: ${waitingAll.length}명</div>`);

    if (waitingAll.length === 0) {
      right.push(`
        <div class="mini-row">
          <div class="mini-left">
            <div class="mini-name">대기자 없음</div>
            <div class="mini-loc">—</div>
          </div>
        </div>
      `);
    } else {
      const sortedWaitingAll = [...waitingAll].sort((a, b) => {
        const aTime = Number(a?.addedAt || 0);
        const bTime = Number(b?.addedAt || 0);
        return aTime - bTime;
      });

      sortedWaitingAll.forEach((w, index) => {
        const start = w.addedAt || Date.now();
        const waitingNo = index + 1;

        right.push(`
          <div class="global-wait-row">
            <div class="global-wait-left">
              <div class="global-wait-order">${waitingNo}</div>
              <div class="global-wait-name">${escapeHtml(w.name)}</div>
              <div class="global-wait-status">대기(공유)</div>
            </div>

            <span
              class="time-chip"
              data-timer="wait"
              data-start="${start}"
              data-target="wait:${w.id}">
              00:00:00
            </span>
          </div>
        `);
      });
    }

    right.push(`<div class="badge" style="margin:12px 0 8px;">배치: ${seatedAll.length}명</div>`);

    if (seatedAll.length === 0) {
      right.push(`
        <div class="mini-row">
          <div class="mini-left">
            <div class="mini-name">배치된 사람 없음</div>
            <div class="mini-loc">—</div>
          </div>
        </div>
      `);
    } else {
      seatedAll.forEach((x) => {
        const start = x.seatedAt || Date.now();

        right.push(`
          <div
            class="global-wait-row seat-jump-row"
            data-jump-event="${escapeHtml(x.eventId)}"
            data-jump-box="${escapeHtml(x.boxId)}"
            data-jump-seat="${escapeHtml(x.seatId)}"
            style="cursor:pointer;"
          >
            <div class="global-wait-left">
              <div class="global-wait-order">●</div>
              <div class="global-wait-name">${escapeHtml(x.name)}</div>
              <div class="global-wait-status">
                ${escapeHtml(x.eventId)} / ${escapeHtml(x.boxId)} / Seat ${escapeHtml(x.seatLabel)}
              </div>
            </div>

            <span
              class="time-chip"
              data-timer="seat"
              data-start="${start}"
              data-target="seat-global:${escapeHtml(x.eventId)}:${escapeHtml(x.boxId)}:${escapeHtml(x.seatId)}">
              00:00:00
            </span>
          </div>
        `);
      });
    }

    right.push(`</div>`);

    html.push(`<div class="panel-split">`);
    html.push(`<div>${left.join("")}</div>`);
    html.push(`${right.join("")}`);
    html.push(`</div>`);

    panelContent.innerHTML = html.join("");

    const addSeatBtn = document.getElementById("addSeatBtn");
    if (addSeatBtn) {
      addSeatBtn.onclick = addSeat;
    }

    panelContent.querySelectorAll("[data-sid]").forEach((el) => {
  el.addEventListener("click", (e) => {
    if (
      e.target &&
      (
        e.target.closest("[data-del]") ||
        e.target.closest("[data-clear-seat]") ||
        e.target.closest(".pill-inline")
      )
    ) return;

    const sid = el.getAttribute("data-sid");
    ui.selectedSeatId = ui.selectedSeatId === sid ? null : sid;
    ui.selectedWaitingId = null;
    render();
  });
});

    panelContent.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSeat(btn.getAttribute("data-del"));
      });
    });

    panelContent.querySelectorAll("[data-clear-seat]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSeat(btn.getAttribute("data-clear-seat"));
      });
    });

    panelContent.querySelectorAll(".seat-jump-row").forEach((row) => {
      row.addEventListener("click", () => {
        const jumpEventId = row.getAttribute("data-jump-event") || "";
        const jumpBoxId = row.getAttribute("data-jump-box") || "";
        const jumpSeatId = row.getAttribute("data-jump-seat") || "";

        sessionStorage.setItem("eventId", jumpEventId);
        sessionStorage.setItem("boxId", jumpBoxId);
        sessionStorage.setItem("focusSeatId", jumpSeatId);

        location.href =
          `./layout.html?eventId=${encodeURIComponent(jumpEventId)}&boxId=${encodeURIComponent(jumpBoxId)}&focusSeatId=${encodeURIComponent(jumpSeatId)}`;
      });
    });
  }

  function renderBoxPanel() {
    panelContent.innerHTML = `
      <div class="panel-title">박스</div>
      <div class="row">
        <div class="left">
          <div style="font-weight:900;">준비중</div>
          <div class="badge">여기는 나중에 Box 기능 붙이면 됩니다</div>
        </div>
      </div>
    `;
  }

  function updateTimers() {
    const now = Date.now();

    document.querySelectorAll(".time-chip[data-start][data-timer]").forEach((chip) => {
      const start = Number(chip.dataset.start || 0);
      if (!start) return;

      const ms = now - start;
      chip.textContent = fmtElapsed(ms);

      const cls = timerClass(ms);
      chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      chip.classList.add(cls);
    });

    document.querySelectorAll(".seat-box[data-seatid]").forEach((box) => {
      const id = box.dataset.seatid;
      const seat = eventState.seats.find((s) => s.id === id);

      if (!seat || isEmptyPerson(seat.person) || !seat.seatedAt) {
        box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
        return;
      }

      const ms = now - seat.seatedAt;
      const cls = timerClass(ms);
      box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      box.classList.add(cls);
    });
  }

  function startTick() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(updateTimers, 1000);
  }

  function bindRealtime() {
    onSnapshot(
      EVENT_REF,
      (snap) => {
        if (!snap.exists()) return;

        const next = snap.data() || {};
        const nextUpdatedAt = Number(next.updatedAt || 0);

        if (nextUpdatedAt <= Number(eventState.updatedAt || 0)) return;

        eventState.version = next.version || 2;
        eventState.eventId = next.eventId || EVENT_ID;
        eventState.boxId = next.boxId || BOX_ID;
        eventState.nextSeatNo = next.nextSeatNo || 1;
        eventState.nextSeatOrder = next.nextSeatOrder || 1;
        eventState.seats = Array.isArray(next.seats) ? next.seats : [];
        eventState.updatedAt = nextUpdatedAt || Date.now();

        render();
      },
      (err) => {
        console.error("EVENT_REF snapshot error:", err);
      }
    );

    onSnapshot(
      WAITING_REF,
      (snap) => {
        if (!snap.exists()) return;

        const nextW = snap.data() || {};
        const nextUpdatedAt = Number(nextW.updatedAt || 0);

        if (nextUpdatedAt <= Number(waitingState.updatedAt || 0)) return;

        waitingState.version = nextW.version || 2;
        waitingState.waiting = Array.isArray(nextW.waiting) ? nextW.waiting : [];
        waitingState.updatedAt = nextUpdatedAt || Date.now();

        render();
      },
      (err) => {
        console.error("WAITING_REF snapshot error:", err);
      }
    );

    onSnapshot(
      LAYOUT_EVENTS_REF,
      (snap) => {
        globalSeatOccupancy = buildGlobalSeatOccupancy(snap.docs);
        renderPanel();
        updateTimers();
      },
      (err) => {
        console.error("LAYOUT_EVENTS_REF snapshot error:", err);
      }
    );

    if (currentUser && !isAdminUser) {
      myNotificationRef = doc(db, "layout_notifications", currentUser.uid);

      onSnapshot(
        myNotificationRef,
        (snap) => {
          if (!snap.exists()) {
            hideSeatAlert();
            stopAlertSoundLoop();
            activeNotificationId = "";
            return;
          }

          const data = snap.data() || {};
          const shouldShow =
            data.type === "seat_assigned" &&
            data.acknowledged === false;

          if (!shouldShow) {
            hideSeatAlert();
            stopAlertSoundLoop();
            activeNotificationId = "";
            return;
          }

          const notificationKey = `${currentUser.uid}_${data.createdAt || ""}_${data.seatId || ""}`;

          if (activeNotificationId !== notificationKey) {
            activeNotificationId = notificationKey;
            showSeatAlert(
              data.message || `Seat ${data.seatLabel || ""}에 배치되었습니다.`
            );
          }
        },
        (err) => {
          console.error("MY_NOTIFICATION snapshot error:", err);
        }
      );
    }
  }

  async function init() {
    if (hasInitialized) return;
    hasInitialized = true;

    const remoteEvent = await loadEventStateRemote();
    const remoteWaiting = await loadWaitingStateRemote();

    if (remoteEvent && typeof remoteEvent === "object") {
      eventState.version = remoteEvent.version || 2;
      eventState.eventId = remoteEvent.eventId || EVENT_ID;
      eventState.boxId = remoteEvent.boxId || BOX_ID;
      eventState.nextSeatNo = remoteEvent.nextSeatNo || 1;
      eventState.nextSeatOrder = remoteEvent.nextSeatOrder || 1;
      eventState.seats = Array.isArray(remoteEvent.seats) ? remoteEvent.seats : [];
      eventState.updatedAt = Number(remoteEvent.updatedAt || Date.now());
    }

    if (remoteWaiting && typeof remoteWaiting === "object") {
      waitingState.version = remoteWaiting.version || 2;
      waitingState.waiting = Array.isArray(remoteWaiting.waiting) ? remoteWaiting.waiting : [];
      waitingState.updatedAt = Number(remoteWaiting.updatedAt || Date.now());
    }

    waitingState.waiting.forEach((w) => {
      if (!w.addedAt) w.addedAt = Date.now();
      if (!("uid" in w)) w.uid = "";
      if (!("email" in w)) w.email = "";
    });

    eventState.seats.forEach((s) => {
      if (!isEmptyPerson(s.person) && !s.seatedAt) s.seatedAt = Date.now();
      if (isEmptyPerson(s.person)) s.seatedAt = null;
      if (s.label == null) s.label = String(s.no ?? "");
      if (!("personUid" in s)) s.personUid = "";
      if (!("personEmail" in s)) s.personEmail = "";
    });

    if (!remoteEvent) {
      await saveEventState();
    }

    if (!remoteWaiting) {
      await saveWaitingState();
    }

    await loadGlobalSeatOccupancy();

    bindRealtime();
    render();
    startTick();

    if (!isAdminUser && !audioUnlocked && !soundPromptShown && !hasSavedSoundPreference()) {
      soundPromptShown = true;
      showSoundPrompt();
    }

    if (FOCUS_SEAT_ID) {
      sessionStorage.removeItem("focusSeatId");
    }
  }

  if (menuBtn) {
    menuBtn.onclick = () => {
      if (isMobile()) {
        pcPanel?.classList.remove("open");
        mobileSheet?.classList.toggle("open");
      } else {
        mobileSheet?.classList.remove("open");
        pcPanel?.classList.toggle("open");
      }
    };
  }

  window.addEventListener("resize", () => {
    if (isMobile()) {
      pcPanel?.classList.remove("open");
    } else {
      mobileSheet?.classList.remove("open");
    }
    render();
  });

  if (backBtn) {
    backBtn.onclick = () => {
      if (TOURNAMENT_ID) {
        sessionStorage.setItem("tournamentId", TOURNAMENT_ID);
        location.href = `./index.html?eventId=${encodeURIComponent(TOURNAMENT_ID)}`;
        return;
      }

      sessionStorage.setItem("eventId", EVENT_ID);
      sessionStorage.setItem("boxId", BOX_ID);
      location.href = `./index.html?eventId=${encodeURIComponent(EVENT_ID)}&boxId=${encodeURIComponent(BOX_ID)}`;
    };
  }

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      ui.activeTab = t.dataset.tab;
      ui.selectedWaitingId = null;
      renderPanel();
      updateTimers();
    });
  });

  if (mobileAddSeatBtn) {
    mobileAddSeatBtn.style.display = canManageLayout() ? "" : "none";
    mobileAddSeatBtn.onclick = () => {
      if (!canManageLayout()) return;
      addSeat();
      mobileSheet?.classList.remove("open");
    };
  }

  if (mobileAddWaitingBtn) {
    mobileAddWaitingBtn.style.display = canManageLayout() ? "" : "none";
    mobileAddWaitingBtn.onclick = () => {
      if (!canManageLayout()) return;
      const name = prompt("대기자 이름");
      if (name) addWaiting(name);
      mobileSheet?.classList.remove("open");
    };
  }

  window.addEventListener("keydown", (e) => {
    if (!canManageLayout()) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;

    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (ui.selectedWaitingId) {
      deleteWaiting(ui.selectedWaitingId);
      return;
    }

    if (ui.selectedSeatId) {
      deleteSeat(ui.selectedSeatId);
      return;
    }
  });

  ["click", "touchstart", "keydown"].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        void unlockAudio();
      },
      { once: true }
    );
  });

  onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("./login.html");
    return;
  }

  currentUser = user;
  currentUserProfile = await loadMyUserProfile();
  isAdminUser =
  currentUserProfile?.role === "admin" ||
  isAdminEmail(user.email || "");

  console.log("[LAYOUT AUTH]", {
    uid: user.uid,
    email: user.email || "",
    profile: currentUserProfile,
    isAdminUser,
    isMobile: isMobile()
  });

  if (!hasInitialized) {
    await init();
  }

  render();
  renderPanel();
  updateTimers();
});
})();