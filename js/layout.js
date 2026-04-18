import { db, auth, getMessagingSafe } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getToken
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";

import { isAdminEmail } from "./app_config.js";

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

  const isMobile = () => window.innerWidth <= 1180;

  function getParam(name) {
    const params = new URLSearchParams(location.search);
    return params.get(name) || sessionStorage.getItem(name) || "";
  }

  const TOURNAMENT_ID = getParam("tournamentId") || "";
  const EVENT_ID = getParam("eventId") || "";
  const BOX_ID = getParam("boxId") || "";
  const FOCUS_SEAT_ID = getParam("focusSeatId") || "";

  const EVENT_DOC_ID = `${EVENT_ID}__${BOX_ID}`;
  const EVENT_REF = doc(db, "layout_events", EVENT_DOC_ID);
  const WAITING_REF = doc(db, "layout_shared", "global_waiting");
  const GLOBAL_SEATS_REF = TOURNAMENT_ID
    ? collection(db, "tournaments", TOURNAMENT_ID, "global_seats")
    : null;

  const VAPID_KEY = "BAZXsr3GQtq_nPLrF7C89mr3ejM7DbS-cBBfWNZzHfcHggNier7C2fbIG0uex3DZl8ykVxbqrli54cCdLkena94";
  const ALERT_VOLUME = 0.4;
  const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

  let currentUser = null;
  let currentUserProfile = null;
  let isAdminUser = false;
  let hasInitialized = false;
  let myNotificationRef = null;
  let stopMyNotificationWatch = null;

  let audioUnlocked = false;
  let audioRepeatTimer = null;
  let audioCtx = null;
  let soundPromptShown = false;
  let activeNotificationId = "";
  let timerHandle = null;
  let saveEventTimer = null;
let saveWaitingTimer = null;
let stopGlobalSeatsSourceWatch = null;
const SAVE_EVENT_DEBOUNCE_MS = 90;
  const SAVE_WAITING_DEBOUNCE_MS = 55;

  /** seatId -> occupancy from tournaments/{id}/global_seats (current EVENT/BOX only) */
  let globalSeatBySeatId = new Map();
  /** getIdentityKey(person) for anyone seated on any global_seat in this tournament (any event/box) */
  let globalSeatedIdentityKeys = new Set();

  const eventState = {
    version: 2,
    eventId: EVENT_ID,
    boxId: BOX_ID,
    nextSeatNo: 1,
    nextSeatOrder: 1,
    seats: [],
    updatedAt: Date.now()
  };

  /** tournaments/.../events/{EVENT_ID} 의 title — 알림 문구용 */
  let cachedEventCardTitle = "";

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
  seatSortMode: "seat"
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

  function sanitizeLayoutState(state) {
  if (!state || typeof state !== "object") return state;

  const next = {
    ...state,
    seats: Array.isArray(state.seats) ? [...state.seats] : [],
    waiting: Array.isArray(state.waiting) ? [...state.waiting] : []
  };

  const seenSeatUid = new Set();

  next.seats = next.seats.map((seat) => {
    if (!seat || typeof seat !== "object") return seat;

    const uid = String(seat.personUid || "").trim();
    const hasPerson =
      String(seat.person || "").trim() &&
      String(seat.person || "").trim() !== "비어있음";

    if (!hasPerson) {
      return {
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      };
    }

    if (uid) {
      if (seenSeatUid.has(uid)) {
        return {
          ...seat,
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null
        };
      }
      seenSeatUid.add(uid);
    }

    return {
      ...seat,
      personUid: uid,
      personEmail: String(seat.personEmail || "").trim(),
      seatedAt: seat.seatedAt ? Number(seat.seatedAt) : Date.now()
    };
  });

  const seatUidSet = new Set(
    next.seats.map((s) => String(s?.personUid || "").trim()).filter(Boolean)
  );

  next.waiting = next.waiting.filter((w) => {
    if (!w || typeof w !== "object") return false;
    const uid = String(w.uid || "").trim();
    if (uid && seatUidSet.has(uid)) return false;
    return true;
  });

  const seenWaitingUid = new Set();
  next.waiting = next.waiting.filter((w) => {
    const uid = String(w.uid || "").trim();
    if (!uid) return true;
    if (seenWaitingUid.has(uid)) return false;
    seenWaitingUid.add(uid);
    return true;
  });

  return next;
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
    const t = String(cachedEventCardTitle || "").trim();
    if (t) return t;
    return String(EVENT_ID || "").trim() || "이벤트";
  }

  async function refreshCachedEventCardTitle() {
    cachedEventCardTitle = "";
    if (!TOURNAMENT_ID || !EVENT_ID) return;
    try {
      const snap = await getDoc(doc(db, "tournaments", TOURNAMENT_ID, "events", EVENT_ID));
      if (!snap.exists()) return;
      const title = String((snap.data() || {}).title || "").trim();
      if (title) cachedEventCardTitle = title;
    } catch (err) {
      console.error("refreshCachedEventCardTitle error:", err);
    }
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

  function isValidDocId(id = "") {
    const value = String(id || "").trim();
    return !!value && !value.includes("/");
  }

  function hasValidLayoutRouteContext() {
    return (
      !!(TOURNAMENT_ID && EVENT_ID && BOX_ID) &&
      isValidDocId(EVENT_ID) &&
      isValidDocId(BOX_ID)
    );
  }

  function hasWritableLayoutContext() {
    return !!(TOURNAMENT_ID && EVENT_ID && BOX_ID);
  }

  function isIdentitySeatedInEvent(identityKey) {
    if (!identityKey) return false;
    return eventState.seats.some((s) => {
      if (isEmptyPerson(s.person)) return false;
      return getSeatIdentity(s) === identityKey;
    });
  }

  /** 다른 이벤트/박스 전역 좌석에만 배치된 사람은 이 화면 대기 목록에서 숨긴다 (global_waiting 공유 혼선 방지). */
  function isIdentitySeatedAnywhereInTournament(identityKey) {
    if (!identityKey) return false;
    if (isIdentitySeatedInEvent(identityKey)) return true;
    if (TOURNAMENT_ID && globalSeatedIdentityKeys.has(identityKey)) return true;
    return false;
  }

  function getWaitingListForDisplay() {
    return waitingState.waiting.filter((w) => !isIdentitySeatedAnywhereInTournament(getWaitingIdentity(w)));
  }

  function clearWaitingSelectionIfSeated() {
    const wid = ui.selectedWaitingId;
    if (!wid) return;
    const w = findWaiting(wid);
    if (!w) return;
    if (isIdentitySeatedAnywhereInTournament(getWaitingIdentity(w))) {
      ui.selectedWaitingId = null;
    }
  }

  /**
   * When tournament global_seats is authoritative, merge into layout_events-backed seats
   * so layout.html matches index / admin even if layout_events projection lags.
   */
  function applyGlobalSeatMapToEventSeats() {
    if (!TOURNAMENT_ID || !EVENT_ID || !BOX_ID) return false;
    if (!(globalSeatBySeatId instanceof Map)) return false;

    let changed = false;

    for (const seat of eventState.seats) {
      const sid = String(seat.id || "").trim();
      if (!sid || !globalSeatBySeatId.has(sid)) continue;

      const g = globalSeatBySeatId.get(sid);
      const gPerson = String(g?.person || "").trim();
      const gEmpty = isEmptyPerson(gPerson) || gPerson === "비어있음";

      if (!gEmpty) {
        const gUid = String(g?.personUid || "").trim();
        const lUid = String(seat.personUid || "").trim();
        const lName = String(seat.person || "").trim();
        if (isEmptyPerson(lName) || lUid !== gUid || lName !== gPerson) {
          seat.person = gPerson;
          seat.personUid = gUid;
          seat.personEmail = String(g?.personEmail || "").trim();
          seat.seatedAt = g?.seatedAt != null ? Number(g.seatedAt) : Date.now();
          changed = true;
        }
      } else if (!isEmptyPerson(seat.person)) {
        clearSeatLocally(seat);
        changed = true;
      }
    }

    if (changed) {
      clearWaitingSelectionIfSeated();
      eventState.updatedAt = Date.now();
    }

    return changed;
  }

  function rebuildGlobalSeatMapFromSnapshot(snap) {
    const next = new Map();
    const seatedKeys = new Set();

    if (!snap || !TOURNAMENT_ID) {
      globalSeatBySeatId = next;
      globalSeatedIdentityKeys = seatedKeys;
      return;
    }

    snap.docs.forEach((d) => {
      const data = d.data() || {};
      const person = String(data.person || "").trim();
      if (!isEmptyPerson(person) && person !== "비어있음") {
        const key = getIdentityKey({
          uid: String(data.personUid || "").trim(),
          email: String(data.personEmail || "").trim(),
          name: person
        });
        if (key) seatedKeys.add(key);
      }

      if (!EVENT_ID || !BOX_ID) return;
      const eid = String(data.currentEventId || data.mappedEventId || "").trim();
      const bid = String(data.boxId || "").trim();
      if (eid !== EVENT_ID || bid !== BOX_ID) return;

      const seatId = String(data.seatId || "").trim();
      if (!seatId) return;

      next.set(seatId, {
        person,
        personUid: String(data.personUid || "").trim(),
        personEmail: String(data.personEmail || "").trim(),
        seatedAt: data.seatedAt != null ? Number(data.seatedAt) : null
      });
    });

    globalSeatBySeatId = next;
    globalSeatedIdentityKeys = seatedKeys;
  }

  function bindTournamentGlobalSeatsMerge() {
    if (stopGlobalSeatsSourceWatch) {
      stopGlobalSeatsSourceWatch();
      stopGlobalSeatsSourceWatch = null;
    }

    globalSeatBySeatId = new Map();
    globalSeatedIdentityKeys = new Set();

    if (!TOURNAMENT_ID || !GLOBAL_SEATS_REF || !hasValidLayoutRouteContext()) {
      return;
    }

    stopGlobalSeatsSourceWatch = onSnapshot(
      GLOBAL_SEATS_REF,
      (snap) => {
        rebuildGlobalSeatMapFromSnapshot(snap);
        const merged = applyGlobalSeatMapToEventSeats();
        if (merged) {
          void healAndPersistState("global_seats_merge");
        }
        render();
        updateTimers();
        renderPanel();
      },
      (err) => {
        console.error("bindTournamentGlobalSeatsMerge error:", err);
      }
    );
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

  function buildGlobalSeatDocId(seatId = "") {
    return `${EVENT_ID}__${BOX_ID}__${String(seatId || "").trim()}`;
  }

  function mapSeatToGlobalSeatDoc(seat = {}) {
    const safeSeat = seat && typeof seat === "object" ? seat : {};
    return {
      seatId: String(safeSeat.id || "").trim(),
      label: String(safeSeat.label ?? safeSeat.no ?? "").trim(),
      no: Number(safeSeat.no || 0) || 0,
      order: Number(safeSeat.order || safeSeat.no || 0) || 0,
      x: Number(safeSeat.x || 0) || 0,
      y: Number(safeSeat.y || 0) || 0,
      person: String(safeSeat.person || "").trim(),
      personUid: String(safeSeat.personUid || "").trim(),
      personEmail: String(safeSeat.personEmail || "").trim(),
      seatedAt: safeSeat.seatedAt ? Number(safeSeat.seatedAt) : null,
      status: isEmptyPerson(safeSeat.person) ? "empty" : "occupied",
      tournamentId: TOURNAMENT_ID,
      mappedEventId: EVENT_ID,
      currentEventId: EVENT_ID,
      boxId: BOX_ID,
      sourceLayoutDocId: EVENT_DOC_ID,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    };
  }

  async function syncGlobalSeatsForCurrentLayout(seats = []) {
    if (!hasWritableLayoutContext() || !GLOBAL_SEATS_REF) return;

    try {
      const safeSeats = Array.isArray(seats) ? seats : [];
      const layoutQuery = query(
        GLOBAL_SEATS_REF,
        where("sourceLayoutDocId", "==", EVENT_DOC_ID)
      );
      const snap = await getDocs(layoutQuery);

      const existingDocs = snap.docs;

      const nextSeatIds = new Set(
        safeSeats.map((s) => String(s?.id || "").trim()).filter(Boolean)
      );

      const ops = [];
      safeSeats.forEach((seat) => {
        const seatId = String(seat?.id || "").trim();
        if (!seatId) return;
        const globalSeatRef = doc(
          db,
          "tournaments",
          TOURNAMENT_ID,
          "global_seats",
          buildGlobalSeatDocId(seatId)
        );
        ops.push({ kind: "set", ref: globalSeatRef, seat });
      });

      existingDocs.forEach((d) => {
        const data = d.data() || {};
        const seatId = String(data.seatId || "").trim();
        if (!seatId || nextSeatIds.has(seatId)) return;
        ops.push({ kind: "del", ref: d.ref });
      });

      const MAX_BATCH = 400;
      for (let i = 0; i < ops.length; i += MAX_BATCH) {
        const slice = ops.slice(i, i + MAX_BATCH);
        const batch = writeBatch(db);
        for (const op of slice) {
          if (op.kind === "set") {
            batch.set(op.ref, mapSeatToGlobalSeatDoc(op.seat), { merge: true });
          } else {
            batch.delete(op.ref);
          }
        }
        await batch.commit();
      }
    } catch (err) {
      console.error("syncGlobalSeatsForCurrentLayout error:", err);
    }
  }

  async function saveEventState() {
    if (!hasWritableLayoutContext()) return;
    try {
      const sanitizedEventState = sanitizeLayoutState({
  seats: clone(eventState.seats),
  waiting: [],
});

await setDoc(
  EVENT_REF,
  {
    ...clone(eventState),
    seats: sanitizedEventState.seats,
    updatedAt: Date.now(),
    updatedAtServer: serverTimestamp()
  },
  { merge: true }
);
      await syncGlobalSeatsForCurrentLayout(sanitizedEventState.seats);
    } catch (err) {
      console.error("saveEventState error:", err);
    }
  }
  

  async function saveWaitingState() {
    if (!hasWritableLayoutContext()) return;
    try {
      const sanitizedWaitingState = sanitizeLayoutState({
  seats: clone(eventState.seats),
  waiting: clone(waitingState.waiting),
});

await setDoc(
  WAITING_REF,
  {
    ...clone(waitingState),
    waiting: sanitizedWaitingState.waiting,
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
    if (!hasWritableLayoutContext()) return;
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

  function flushEventSaveNow() {
  if (saveEventTimer) {
    clearTimeout(saveEventTimer);
    saveEventTimer = null;
  }
  eventState.updatedAt = Date.now();
  void saveEventState();
}

function flushWaitingSaveNow() {
  if (saveWaitingTimer) {
    clearTimeout(saveWaitingTimer);
    saveWaitingTimer = null;
  }
  waitingState.updatedAt = Date.now();
  void saveWaitingState();
}

function touchEvent(immediate = false) {
  eventState.updatedAt = Date.now();

  if (immediate) {
    flushEventSaveNow();
    return;
  }

  if (saveEventTimer) clearTimeout(saveEventTimer);
  saveEventTimer = setTimeout(() => {
    saveEventTimer = null;
    void saveEventState();
  }, SAVE_EVENT_DEBOUNCE_MS);
}

function touchWaiting(immediate = false) {
  waitingState.updatedAt = Date.now();

  if (immediate) {
    flushWaitingSaveNow();
    return;
  }

  if (saveWaitingTimer) clearTimeout(saveWaitingTimer);
  saveWaitingTimer = setTimeout(() => {
    saveWaitingTimer = null;
    void saveWaitingState();
  }, SAVE_WAITING_DEBOUNCE_MS);
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
      gain.gain.linearRampToValueAtTime(ALERT_VOLUME, now + 0.01);
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
        <div class="modal-text">배치 알림 시 소리가 반복 재생되도록 활성화합니다.</div>
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

  const eventTitle = String(meta.eventTitle || "").trim();
  const seatLabel = String(meta.seatLabel || "").trim();
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

  const card = overlay.querySelector(".modal-card");

  const ackBtn = document.getElementById("seatAlertAcknowledgeBtn");
  const moveBtn = document.getElementById("seatAlertMoveBtn");

  ackBtn?.addEventListener("click", async () => {
    stopAlertSoundLoop();
    hideSeatAlert();
    await acknowledgeMyNotification();
  });

  moveBtn?.addEventListener("click", () => {
    stopAlertSoundLoop();
    location.href = targetUrl;
  });

  void startAlertSoundLoop();
}

  function showBrowserNotification(title, body = "") {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    new Notification(title, {
      body,
      tag: "layout-seat-assigned",
      renotify: true
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

function applySeatNotificationSnapshot(snap) {
  if (!currentUser) {
    resetSeatNotificationUi();
    return;
  }

  if (!snap.exists()) {
    resetSeatNotificationUi();
    return;
  }

  const data = snap.data() || {};

  const shouldShow =
    String(data.type || "").trim() === "seat_assigned" &&
    data.acknowledged !== true;

  if (!shouldShow) {
    resetSeatNotificationUi();
    return;
  }

  const notificationKey = [
    currentUser.uid || "",
    data.createdAt || "",
    data.seatId || "",
    data.eventId || "",
    data.boxId || ""
  ].join("__");

  if (activeNotificationId === notificationKey) return;
  activeNotificationId = notificationKey;

  const msg =
    String(data.message || "").trim() ||
    `Seat ${String(data.seatLabel || "").trim()}에 배치되었습니다.`;

  showSeatAlert(msg, {
    eventTitle: data.eventTitle || "",
    seatLabel: data.seatLabel || "",
    targetUrl: data.targetUrl || ""
  });

  if (document.hidden) {
    showBrowserNotification("배치 알림", msg);
  }
}

async function showPendingSeatNotificationOnce() {
  if (!currentUser) {
    resetSeatNotificationUi();
    return;
  }

  try {
    const ref = doc(db, "layout_notifications", currentUser.uid);
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

  if (!currentUser) {
    myNotificationRef = null;
    resetSeatNotificationUi();
    return;
  }

  myNotificationRef = doc(db, "layout_notifications", currentUser.uid);

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

  async function registerPushIfPossible() {
    try {
      const messaging = await getMessagingSafe();
      if (!messaging) return null;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") return null;

      const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration
      });

      return token || null;
    } catch (err) {
      console.error("registerPushIfPossible error:", err);
      return null;
    }
  }

  async function savePushToken(token) {
    if (!currentUser || !token) return;

    try {
      await setDoc(
        doc(db, "users", currentUser.uid),
        {
          fcmToken: token,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("savePushToken error:", err);
    }
  }

  function pickDisplayName(profile, user) {
    const nick = String(profile?.nickname || "").trim();
    if (nick) return nick;

    const displayName = String(user?.displayName || "").trim();
    if (displayName) return displayName;

    const email = String(profile?.email || user?.email || "").trim();
    if (email) return email.split("@")[0];

    return "Dealer";
  }

  /** 캔버스 좌석: "Seat" 없이 숫자만 */
  function seatCanvasDigitsOnly(label, no) {
    const l = String(label ?? "").trim();
    const nStr = no != null && no !== "" ? String(no).trim() : "";
    const fromLabel = l.replace(/\D/g, "");
    if (fromLabel) return fromLabel;
    const fromNo = nStr.replace(/\D/g, "");
    if (fromNo) return fromNo;
    return "—";
  }

  /** 통합 배치도(global-layout)와 동일: 대기 경과 시간 기준 시각 */
  function millisFromWaitingTimeField(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") {
      if (!Number.isFinite(v) || v <= 0) return 0;
      return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
    }
    if (v instanceof Date) return v.getTime();
    if (typeof v?.toMillis === "function") return Number(v.toMillis()) || 0;
    if (typeof v?.seconds === "number") {
      return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
  }

  function getWaitingTimerStartMs(raw = {}) {
    const keys = [
      "joinedAt",
      "createdAt",
      "joinedAtServer",
      "updatedAtServer",
      "updatedAt",
      "addedAt",
      "carryStartedAt"
    ];
    for (const k of keys) {
      const ms = millisFromWaitingTimeField(raw[k]);
      if (ms > 0) return ms;
    }
    return Date.now();
  }

  function normalizeWaitingEntry(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = String(raw.id || makeUid("wait")).trim();
  const name = String(raw.name || "").trim();
  if (!name) return null;

  return {
    id,
    name,
    uid: String(raw.uid || "").trim(),
    email: String(raw.email || "").trim(),
    tournamentId: String(raw.tournamentId || TOURNAMENT_ID || "").trim(),
    addedAt: getWaitingTimerStartMs(raw),
    carryStartedAt: raw.carryStartedAt ? Number(raw.carryStartedAt) : null
  };
}

  function normalizeWaitingName(name = "") {
    return String(name || "").trim().slice(0, 30);
  }

  function sortWaitingAscending(list) {
    return [...list].sort((a, b) => getWaitingTimerStartMs(a) - getWaitingTimerStartMs(b));
  }

  function removeWaitingById(waitingId) {
    const idx = waitingState.waiting.findIndex((w) => w.id === waitingId);
    if (idx >= 0) {
      waitingState.waiting.splice(idx, 1);
      return true;
    }
    return false;
  }

  function findWaiting(waitingId) {
    return waitingState.waiting.find((w) => w.id === waitingId) || null;
  }

  function findSeat(seatId) {
    return eventState.seats.find((s) => s.id === seatId) || null;
  }

  function getSortedSeats(list = []) {
  const seats = [...list];

  if (ui.seatSortMode === "time") {
    return seats.sort((a, b) => {
      const aOccupied = !isEmptyPerson(a.person);
      const bOccupied = !isEmptyPerson(b.person);

      // 배치된 사람 먼저
      if (aOccupied !== bOccupied) return aOccupied ? -1 : 1;

      // 둘 다 비어있으면 seat 순
      if (!aOccupied && !bOccupied) {
        return (a.order ?? a.no ?? 0) - (b.order ?? b.no ?? 0);
      }

      // 둘 다 배치중이면 오래된 시간순
      const aTime = Number(a.seatedAt || 0);
      const bTime = Number(b.seatedAt || 0);
      if (aTime !== bTime) return aTime - bTime;

      // 같으면 seat 순
      return (a.order ?? a.no ?? 0) - (b.order ?? b.no ?? 0);
    });
  }

  // 기본: seat 순
  return seats.sort((a, b) => {
    return (a.order ?? a.no ?? 0) - (b.order ?? b.no ?? 0);
  });
}

  function getCanvasSize() {
    const rect = app.getBoundingClientRect();
    return {
      width: Math.max(320, Math.floor(rect.width || window.innerWidth || 1200)),
      height: Math.max(420, Math.floor(rect.height || (window.innerHeight - 64) || 700))
    };
  }

  function getNextSeatPosition() {
    const { width, height } = getCanvasSize();
    const PAD = 16;
    const BOX_W = 170;
    const BOX_H = 90;
    const GAP_X = 16;
    const GAP_Y = 16;
    const START_Y = 24;
    const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP_X) / (BOX_W + GAP_X)));

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

    captureLayoutUndo("add_seat");

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

    touchEvent(true);
    render();
  }

  function deleteSeat(seatId) {
  if (!canManageLayout()) return;

  captureLayoutUndo("delete_seat");

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

  touchEvent(true);
  render();

  if (prevUid && prevName) {
    void moveDealerToWaiting({
      uid: prevUid,
      email: prevEmail,
      nickname: prevName
    });
  }
}

function addWaiting(name, meta = {}) {
  if (!canManageLayout()) return;

  const v = normalizeWaitingName(name);
  if (!v) return;

  const uid = String(meta.uid || "").trim();
  const email = String(meta.email || "").trim();
  const tournamentId = String(meta.tournamentId || TOURNAMENT_ID || "").trim();
  const identityKey = getIdentityKey({ uid, email, name: v });
  const exists = waitingState.waiting.some((w) => getWaitingIdentity(w) === identityKey);
  if (exists) return;

  captureLayoutUndo("add_waiting");

  waitingState.waiting.push({
    id: makeUid("wait"),
    name: v,
    uid,
    email,
    tournamentId,
    addedAt: Date.now(),
    carryStartedAt: meta.carryStartedAt ? Number(meta.carryStartedAt) : null
  });

  touchWaiting(true);
  render();
}

  function deleteWaiting(waitingId) {
    if (!canManageLayout()) return;

    captureLayoutUndo("delete_waiting");

    removeWaitingById(waitingId);
    if (ui.selectedWaitingId === waitingId) ui.selectedWaitingId = null;
    touchWaiting(true);
    render();
  }

  async function setDealerStatus(uid, patch = {}) {
    if (!uid || !TOURNAMENT_ID) return;

    try {
      const ref = doc(db, "dealer_attendance", `${TOURNAMENT_ID}__${uid}`);
      await setDoc(
        ref,
        {
          uid,
          tournamentId: TOURNAMENT_ID,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp(),
          ...patch
        },
        { merge: true }
      );
    } catch (err) {
      console.error("setDealerStatus error:", err);
    }
  }

  const DEALER_STATUS_COMPARE_KEYS = [
    "email",
    "nickname",
    "status",
    "currentEventId",
    "currentBoxId",
    "currentSeatId",
    "currentSeatLabel"
  ];

  async function applyDealerAttendancePatchesBatched(pairs = []) {
    if (!TOURNAMENT_ID) return;

    const dedup = new Map();
    for (const row of pairs) {
      const uid = String(row?.uid || "").trim();
      if (!uid) continue;
      if (dedup.has(uid)) continue;
      dedup.set(uid, row.patch || {});
    }

    const list = Array.from(dedup.entries());
    if (!list.length) return;

    const MAX_CHUNK = 400;

    for (let c = 0; c < list.length; c += MAX_CHUNK) {
      const chunk = list.slice(c, c + MAX_CHUNK);
      const refs = chunk.map(([uid]) => doc(db, "dealer_attendance", `${TOURNAMENT_ID}__${uid}`));
      const snaps = await Promise.all(refs.map((r) => getDoc(r)));

      const batch = writeBatch(db);
      let writes = 0;

      for (let i = 0; i < chunk.length; i++) {
        const [uid, patch] = chunk[i];
        const prev = snaps[i].exists() ? snaps[i].data() || {} : {};
        const next = { uid, tournamentId: TOURNAMENT_ID, ...patch };
        const changed = DEALER_STATUS_COMPARE_KEYS.some(
          (key) => String(prev[key] ?? "") !== String(next[key] ?? "")
        );
        if (!changed) continue;

        batch.set(
          refs[i],
          {
            uid,
            tournamentId: TOURNAMENT_ID,
            updatedAt: Date.now(),
            updatedAtServer: serverTimestamp(),
            ...patch
          },
          { merge: true }
        );
        writes += 1;
      }

      if (writes) await batch.commit();
    }
  }

  async function moveDealerToWaiting(meta = {}) {
  const uid = String(meta.uid || "").trim();
  const email = String(meta.email || "").trim();
  let nickname = String(meta.nickname || "").trim();

  const carryStartedAt = meta.carryStartedAt
    ? Number(meta.carryStartedAt)
    : null;

  if (!nickname && uid) {
    try {
      const snap = await getDoc(doc(db, "users", uid));
      if (snap.exists()) {
        const data = snap.data() || {};
        nickname = String(data.nickname || "").trim();
      }
    } catch (e) {
      console.error("nickname fetch error", e);
    }
  }

  if (!nickname) {
    nickname = email || "Dealer";
  }

  if (!uid && !nickname) return;

  const identityKey = getIdentityKey({
    uid,
    email,
    name: nickname
  });

  const exists = waitingState.waiting.some((w) => {
    return getWaitingIdentity(w) === identityKey;
  });

  if (!exists) {
    waitingState.waiting.push({
      id: makeUid("wait"),
      name: nickname,
      uid,
      email,
      tournamentId: TOURNAMENT_ID,
      addedAt: Date.now(),
      carryStartedAt: carryStartedAt || null
    });
    touchWaiting(true);
  }

  if (uid) {
    await setDealerStatus(uid, {
      email,
      nickname,
      status: "waiting",
      currentEventId: "",
      currentBoxId: "",
      currentSeatId: "",
      currentSeatLabel: ""
    });
  }
}

async function moveDealerToAssigned({
  uid = "",
  email = "",
  name = "",
  seatId = "",
  seatLabel = "",
  eventId = "",
  boxId = "",
  resolvedDisplayName = null
}) {
  if (!uid && !name && !email) return;

  const trimmedResolved =
    resolvedDisplayName != null ? String(resolvedDisplayName).trim() : "";
  const displayName = trimmedResolved
    ? trimmedResolved
    : await getBestDisplayName(uid, email, name);
  const identityKey = getIdentityKey({
    uid,
    email,
    name: displayName
  });

  if (identityKey) {
    removeWaitingEntriesByIdentity(identityKey);
  } else {
    waitingState.waiting = waitingState.waiting.filter((w) => {
      if (!w || typeof w !== "object") return false;
      return String(w.uid || "").trim() !== String(uid).trim();
    });
  }

  touchWaiting(true);

  if (uid) {
    await setDealerStatus(uid, {
      email: String(email || "").trim(),
      nickname: String(displayName || "").trim(),
      status: "assigned",
      currentEventId: String(eventId || "").trim(),
      currentBoxId: String(boxId || "").trim(),
      currentSeatId: String(seatId || "").trim(),
      currentSeatLabel: String(seatLabel || "").trim()
    });
  }
}

  function captureLayoutUndo(label = "") {
    ui.lastUndoAction = {
      label,
      eventState: clone(eventState),
      waitingState: clone(waitingState),
      selectedSeatId: ui.selectedSeatId,
      selectedWaitingId: ui.selectedWaitingId,
      capturedAt: Date.now()
    };
  }

  async function syncStatusesFromCurrentState() {
    const waitingByUid = new Map();
    waitingState.waiting.forEach((w) => {
      const uid = String(w.uid || "").trim();
      if (!uid) return;
      waitingByUid.set(uid, w);
    });

    const seatByUid = new Map();
    eventState.seats.forEach((seat) => {
      const uid = String(seat.personUid || "").trim();
      if (!uid || isEmptyPerson(seat.person)) return;
      seatByUid.set(uid, seat);
    });

    const allUids = new Set([...waitingByUid.keys(), ...seatByUid.keys()]);
    const pairs = [];

    for (const uid of allUids) {
      const seat = seatByUid.get(uid);
      if (seat) {
        pairs.push({
          uid,
          patch: {
            email: String(seat.personEmail || "").trim(),
            nickname: String(seat.person || "").trim(),
            status: "assigned",
            currentEventId: EVENT_ID,
            currentBoxId: BOX_ID,
            currentSeatId: String(seat.id || "").trim(),
            currentSeatLabel: String(seat.label ?? seat.no ?? "")
          }
        });
        continue;
      }

      const waiting = waitingByUid.get(uid);
      if (waiting) {
        pairs.push({
          uid,
          patch: {
            email: String(waiting.email || "").trim(),
            nickname: String(waiting.name || "").trim(),
            status: "waiting",
            currentEventId: "",
            currentBoxId: "",
            currentSeatId: "",
            currentSeatLabel: ""
          }
        });
      }
    }

    if (pairs.length) await applyDealerAttendancePatchesBatched(pairs);
  }

  function getIdentityKey({ uid = "", email = "", name = "" } = {}) {
    const safeUid = String(uid || "").trim();
    if (safeUid) return `uid:${safeUid}`;

    const safeEmail = String(email || "").trim().toLowerCase();
    if (safeEmail) return `email:${safeEmail}`;

    const safeName = String(name || "").trim();
    if (safeName) return `name:${safeName}`;

    return "";
  }

  function getWaitingIdentity(waiting) {
    return getIdentityKey({
      uid: waiting?.uid || "",
      email: waiting?.email || "",
      name: waiting?.name || ""
    });
  }

  function getSeatIdentity(seat) {
    return getIdentityKey({
      uid: seat?.personUid || "",
      email: seat?.personEmail || "",
      name: seat?.person || ""
    });
  }

  function removeWaitingEntriesByIdentity(identityKey) {
    if (!identityKey) return 0;

    const before = waitingState.waiting.length;
    waitingState.waiting = waitingState.waiting.filter((w) => getWaitingIdentity(w) !== identityKey);
    return before - waitingState.waiting.length;
  }

  function findSeatByIdentity(identityKey, excludeSeatId = "") {
    if (!identityKey) return null;

    return eventState.seats.find((seat) => {
      if (excludeSeatId && seat.id === excludeSeatId) return false;
      if (isEmptyPerson(seat.person)) return false;
      return getSeatIdentity(seat) === identityKey;
    }) || null;
  }

  function clearSeatLocally(seat) {
    if (!seat) return;

    seat.person = "비어있음";
    seat.personUid = "";
    seat.personEmail = "";
    seat.seatedAt = null;
  }

  function reconcileLocalState() {
  let changedEvent = false;
  let changedWaiting = false;

  const nextWaiting = [];
  const waitingSeen = new Map();

  for (const raw of waitingState.waiting) {
    const w = normalizeWaitingEntry(raw);
    if (!w) {
      changedWaiting = true;
      continue;
    }

    const key = getWaitingIdentity(w);
    if (!key) {
      changedWaiting = true;
      continue;
    }

    const existing = waitingSeen.get(key);
    if (!existing) {
      waitingSeen.set(key, w);
      nextWaiting.push(w);
      continue;
    }

    changedWaiting = true;

    const existingAddedAt = Number(existing.addedAt || Date.now());
    const nextAddedAt = Number(w.addedAt || Date.now());

    if (nextAddedAt < existingAddedAt) {
      existing.addedAt = nextAddedAt;
    }

    if (!existing.carryStartedAt && w.carryStartedAt) {
      existing.carryStartedAt = Number(w.carryStartedAt);
    }
  }

  waitingState.waiting = nextWaiting;

  const seatSeen = new Map();

  for (const seat of eventState.seats) {
    if (isEmptyPerson(seat.person)) continue;

    const key = getSeatIdentity(seat);
    if (!key) continue;

    const already = seatSeen.get(key);
    if (!already) {
      seatSeen.set(key, seat);
      continue;
    }

    const alreadyTime = Number(already.seatedAt || Date.now());
    const seatTime = Number(seat.seatedAt || Date.now());

    if (seatTime < alreadyTime) {
      clearSeatLocally(already);
      seatSeen.set(key, seat);
    } else {
      clearSeatLocally(seat);
    }

    changedEvent = true;
  }

  return { changedEvent, changedWaiting };
}

  async function syncCurrentEventUserTruth() {
    const seatKeys = new Map();
    const waitingKeys = new Map();

    eventState.seats.forEach((seat) => {
      if (isEmptyPerson(seat.person)) return;

      const key = getSeatIdentity(seat);
      if (!key) return;

      seatKeys.set(key, {
        uid: String(seat.personUid || "").trim(),
        email: String(seat.personEmail || "").trim(),
        nickname: String(seat.person || "").trim(),
        seatId: String(seat.id || "").trim(),
        seatLabel: String(seat.label ?? seat.no ?? "")
      });
    });

    waitingState.waiting.forEach((w) => {
      const key = getWaitingIdentity(w);
      if (!key) return;

      waitingKeys.set(key, {
        uid: String(w.uid || "").trim(),
        email: String(w.email || "").trim(),
        nickname: String(w.name || "").trim()
      });
    });

    const pairs = [];
    for (const [, item] of seatKeys) {
      if (!item.uid) continue;
      pairs.push({
        uid: item.uid,
        patch: {
          email: item.email,
          nickname: item.nickname,
          status: "assigned",
          currentEventId: EVENT_ID,
          currentBoxId: BOX_ID,
          currentSeatId: item.seatId,
          currentSeatLabel: item.seatLabel
        }
      });
    }

    for (const [key, item] of waitingKeys) {
      if (seatKeys.has(key)) continue;
      if (!item.uid) continue;
      pairs.push({
        uid: item.uid,
        patch: {
          email: item.email,
          nickname: item.nickname,
          status: "waiting",
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: ""
        }
      });
    }

    if (pairs.length) await applyDealerAttendancePatchesBatched(pairs);
  }

  async function healAndPersistState(reason = "") {
    const { changedEvent, changedWaiting } = reconcileLocalState();

    const saves = [];
    if (changedEvent) {
      eventState.updatedAt = Date.now();
      saves.push(saveEventState());
    }
    if (changedWaiting) {
      waitingState.updatedAt = Date.now();
      saves.push(saveWaitingState());
    }
    if (saves.length) await Promise.all(saves);

    if (changedEvent || changedWaiting) {
      await syncCurrentEventUserTruth();
      console.log("[healAndPersistState]", reason, { changedEvent, changedWaiting });
    }
  }

  async function undoLastAction() {
    if (!canManageLayout()) return;
    if (!ui.lastUndoAction) return;

    const snap = ui.lastUndoAction;
    eventState.version = snap.eventState.version;
    eventState.eventId = snap.eventState.eventId;
    eventState.boxId = snap.eventState.boxId;
    eventState.nextSeatNo = snap.eventState.nextSeatNo;
    eventState.nextSeatOrder = snap.eventState.nextSeatOrder;
    eventState.seats = Array.isArray(snap.eventState.seats) ? clone(snap.eventState.seats) : [];
    eventState.updatedAt = Date.now();

    waitingState.version = snap.waitingState.version;
    waitingState.waiting = Array.isArray(snap.waitingState.waiting) ? clone(snap.waitingState.waiting) : [];
    waitingState.updatedAt = Date.now();

    ui.selectedSeatId = snap.selectedSeatId || null;
    ui.selectedWaitingId = snap.selectedWaitingId || null;
    ui.lastUndoAction = null;

    await Promise.all([saveEventState(), saveWaitingState()]);
    await syncStatusesFromCurrentState();
    render();
  }

async function assignWaitingToSeat(waitingId, seatId) {
  if (!canManageLayout()) return;

  const waiting = normalizeWaitingEntry(findWaiting(waitingId));
  const seat = findSeat(seatId);
  if (!waiting || !seat) return;

  captureLayoutUndo("assign_waiting_to_seat");

  const incomingName = String(waiting.name || "").trim();
  const incomingUid = String(waiting.uid || "").trim();
  const incomingEmail = String(waiting.email || "").trim();

  const incomingDisplayName =
    incomingName.length >= 2 && !incomingName.includes("@")
      ? incomingName
      : await getBestDisplayName(incomingUid, incomingEmail, incomingName);

  const incomingKey = getIdentityKey({
    uid: incomingUid,
    email: incomingEmail,
    name: incomingDisplayName
  });

  const prevName = String(seat.person || "").trim();
  const prevUid = String(seat.personUid || "").trim();
  const prevEmail = String(seat.personEmail || "").trim();
  const prevSeatedAt = seat.seatedAt ? Number(seat.seatedAt) : null;
  const prevOccupied = !!prevName && prevName !== "비어있음";

  if (incomingKey) {
    removeWaitingEntriesByIdentity(incomingKey);
  } else {
    removeWaitingById(waitingId);
  }

  const duplicatedSeat = findSeatByIdentity(incomingKey, seat.id);
  if (duplicatedSeat) {
    clearSeatLocally(duplicatedSeat);
  }

  if (prevOccupied && prevUid && prevUid !== incomingUid) {
    await Promise.all([
      clearUserSeatNotification(prevUid, "seat_reassigned"),
      moveDealerToWaiting({
        uid: prevUid,
        email: prevEmail,
        nickname: prevName,
        carryStartedAt: prevSeatedAt || Date.now()
      })
    ]);
  }

  seat.person = incomingDisplayName || "비어있음";
  seat.personUid = incomingUid;
  seat.personEmail = incomingEmail;
  seat.seatedAt = Date.now();

  ui.selectedWaitingId = null;
  ui.selectedSeatId = seat.id;

  touchWaiting(true);
  touchEvent(true);
  render();
  updateTimers();

  const followUps = [];

  if (incomingUid || incomingDisplayName) {
    followUps.push(
      moveDealerToAssigned({
        uid: incomingUid,
        email: incomingEmail,
        name: incomingDisplayName,
        resolvedDisplayName: incomingDisplayName,
        seatId: seat.id,
        seatLabel: seat.label ?? seat.no ?? "",
        eventId: EVENT_ID,
        boxId: BOX_ID
      })
    );
  }

  if (incomingUid) {
    const seatLabel = String(seat.label ?? seat.no ?? "").trim();
    const eventTitle = getCurrentEventTitle();
    const tournamentId = getCurrentTournamentId();

    followUps.push(
      writeUserNotification({
        uid: incomingUid,
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
      })
    );
  }

  if (followUps.length) await Promise.all(followUps);
  await healAndPersistState("assignWaitingToSeat");
}

  async function clearSeat(seatId) {
    if (!canManageLayout()) return;

    const seat = findSeat(seatId);
    if (!seat) return;

    captureLayoutUndo("clear_seat");

    const prevName = String(seat.person || "").trim();
    const prevUid = String(seat.personUid || "").trim();
    const prevEmail = String(seat.personEmail || "").trim();
    const prevSeatedAt = seat.seatedAt ? Number(seat.seatedAt) : null;
    const hadPerson = !isEmptyPerson(prevName);

    clearSeatLocally(seat);

    if (hadPerson) {
      const rel = [
        moveDealerToWaiting({
          uid: prevUid,
          email: prevEmail,
          nickname: prevName,
          carryStartedAt: prevSeatedAt || Date.now()
        })
      ];
      if (prevUid) rel.push(clearUserSeatNotification(prevUid, "seat_cleared"));
      await Promise.all(rel);
    }

    touchEvent(true);
    render();
    updateTimers();
    await healAndPersistState("clearSeat");
  }

  

  async function getBestDisplayName(uid = "", fallbackEmail = "", fallbackName = "") {
  const safeUid = String(uid || "").trim();
  const safeEmail = String(fallbackEmail || "").trim();
  const safeName = String(fallbackName || "").trim();

  if (safeUid) {
    try {
      const snap = await getDoc(doc(db, "users", safeUid));
      if (snap.exists()) {
        const data = snap.data() || {};
        const nickname = String(data.nickname || "").trim();
        if (nickname) return nickname;
      }
    } catch (err) {
      console.error("getBestDisplayName error:", err);
    }
  }

  if (safeName && !safeName.includes("@")) return safeName;
  if (safeEmail) return safeEmail;
  return safeName || "Dealer";
}

  function dragSeatBy(seatId, dx, dy) {
  if (!canManageLayout()) return;

  const seat = findSeat(seatId);
  if (!seat) return;

  const { width, height } = getCanvasSize();
  const boxW = 170;
  const boxH = 90;
  const pad = 8;

  seat.x = Math.max(pad, Math.min((seat.x || 0) + dx, width - boxW - pad));
  seat.y = Math.max(pad, Math.min((seat.y || 0) + dy, height - boxH - pad));

  eventState.updatedAt = Date.now();
  render();
}

  function buildCanvas() {
    const canvas = document.createElement("div");
    canvas.className = "pc-canvas";

    eventState.seats.forEach((seat) => {
      const box = document.createElement("div");
      const hasPerson = !isEmptyPerson(seat.person);
      const isSel = ui.selectedSeatId === seat.id;
      const seatedAtMs = hasPerson ? Number(seat.seatedAt || 0) : 0;
      const elapsedMs = hasPerson ? (seatedAtMs > 0 ? Date.now() - seatedAtMs : 0) : 0;
      const timerCls = hasPerson ? timerClass(elapsedMs) : "";
      box.className = ["seat-box", hasPerson ? "is-occupied" : "", timerCls, isSel ? "selected" : ""]
        .filter(Boolean)
        .join(" ");
      box.dataset.seatid = seat.id;
      box.style.left = `${seat.x || 0}px`;
      box.style.top = `${seat.y || 0}px`;
      const personClass = hasPerson ? "seat-person" : "seat-person is-empty";
      const seatLabel = String(seat.label ?? seat.no ?? "").trim() || "—";
      box.innerHTML = `
        <div class="seat-title">SEAT ${escapeHtml(seatLabel)}</div>
        <div class="${personClass}">${escapeHtml(hasPerson ? seat.person : "-")}</div>
      `;
      canvas.appendChild(box);

      box.addEventListener("click", async (e) => {
        e.stopPropagation();

        const now = Date.now();
        const occupied = !isEmptyPerson(seat.person);

        if (ui.selectedWaitingId) {
          ui.selectedSeatId = seat.id;
          await assignWaitingToSeat(ui.selectedWaitingId, seat.id);
          ui.selectedSeatId = null;
          ui.lastMouseClickAt = 0;
          ui.lastMouseSeatId = "";
          render();
          return;
        }

        if (occupied && canManageLayout()) {
          if (ui.lastMouseSeatId === seat.id && now - ui.lastMouseClickAt < 380) {
            ui.lastMouseClickAt = 0;
            ui.lastMouseSeatId = "";
            await clearSeat(seat.id);
            ui.selectedSeatId = null;
            render();
            return;
          }

          ui.lastMouseClickAt = now;
          ui.lastMouseSeatId = seat.id;
          ui.selectedSeatId = seat.id;
          render();
          return;
        }

        ui.lastMouseClickAt = now;
        ui.lastMouseSeatId = seat.id;
        ui.selectedSeatId = seat.id;
        render();
      });

      if (!canManageLayout()) return;

      let startX = 0;
      let startY = 0;
      let moved = false;

      const onMove = (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;

        dragSeatBy(seat.id, dx, dy);
        startX = clientX;
        startY = clientY;
      };

      box.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        moved = false;

        const mm = (ev) => onMove(ev.clientX, ev.clientY);
        const mu = () => {
  window.removeEventListener("mousemove", mm);
  window.removeEventListener("mouseup", mu);

  if (moved) {
    touchEvent(true);
  }
};

        window.addEventListener("mousemove", mm);
        window.addEventListener("mouseup", mu);
      });

      box.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        if (!t) return;
        startX = t.clientX;
        startY = t.clientY;
        moved = false;
      }, { passive: true });

      box.addEventListener("touchmove", (e) => {
        const t = e.touches[0];
        if (!t) return;
        onMove(t.clientX, t.clientY);
      }, { passive: true });

      box.addEventListener("touchend", () => {
  if (moved) {
    touchEvent(true);
  }
}, { passive: true });
    });

    return canvas;
  }

  function render() {
    app.innerHTML = "";

    if (isMobile()) {
      renderMobile();
      mobileSheet?.classList.remove("open");
    } else {
      app.appendChild(buildCanvas());
      renderPanel();
      updateTimers();
    }
  }

  function renderMobile() {
    const wrap = document.createElement("div");
    wrap.className = "mobile";

    const displayWaitingMobile = getWaitingListForDisplay();
    const selectedWaiting =
      ui.selectedWaitingId
        ? displayWaitingMobile.find((w) => w.id === ui.selectedWaitingId) || null
        : null;

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
          <span class="badge sel">배치할 대기</span>
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
      getSortedSeats(eventState.seats).forEach((s) => {
          const hasPerson = !isEmptyPerson(s.person);
          const start = hasPerson ? (s.seatedAt || Date.now()) : null;
          const isSel = ui.selectedSeatId === s.id;

          seatCard.innerHTML += `
            <div class="mobile-seat-row compact ${isSel ? "selected" : ""}" data-mobile-seat="${s.id}">
              <div class="mobile-seat-mainline">
                <div class="mobile-seat-inline">
  <div class="mobile-seat-leftpack">
    <div class="mobile-seat-textstack">
      <div class="mobile-seat-name-row">
        <span class="mobile-seat-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
        <div class="mobile-seat-person ${isEmptyPerson(s.person) ? "is-empty" : ""}">
          ${isEmptyPerson(s.person) ? "비어있음" : escapeHtml(s.person)}
        </div>
      </div>
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

    const sortedWaiting = [...displayWaitingMobile].sort(
      (a, b) => getWaitingTimerStartMs(a) - getWaitingTimerStartMs(b)
    );

    if (sortedWaiting.length === 0) {
      waitCard.innerHTML += `
        <div class="row">
          <div>대기</div>
          <div class="muted">없음</div>
        </div>
      `;
    } else {
      sortedWaiting.forEach((w) => {
        const start = getWaitingTimerStartMs(w);
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

        const seatObj = eventState.seats.find((x) => x.id === sid);
        const occupied = seatObj && !isEmptyPerson(seatObj.person);
        const now = Date.now();

        if (ui.selectedWaitingId) {
  ui.selectedSeatId = sid;
  await assignWaitingToSeat(ui.selectedWaitingId, sid);
  ui.selectedSeatId = null;
  ui.lastMobileTapAt = 0;
  ui.lastMobileSeatId = "";
  render();
  return;
}

        if (occupied && canManageLayout()) {
          if (ui.lastMobileSeatId === sid && now - ui.lastMobileTapAt < 380) {
            ui.lastMobileTapAt = 0;
            ui.lastMobileSeatId = "";
            await clearSeat(sid);
ui.selectedSeatId = null;
render();
return;
          }

          ui.lastMobileTapAt = now;
          ui.lastMobileSeatId = sid;
          ui.selectedSeatId = sid;
          render();
          return;
        }

        ui.lastMobileTapAt = now;
        ui.lastMobileSeatId = sid;
        ui.selectedSeatId = sid;
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
        if (!wid) return;

        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        ui.selectedSeatId = null;
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
          alert("먼저 대기 행을 눌러 배치할 사람을 지정하세요.");
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
     btn.addEventListener("click", async (e) => {
  e.stopPropagation();
  await clearSeat(btn.getAttribute("data-clear-seat"));
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
    const displayWaiting = getWaitingListForDisplay();

    if (canManageLayout()) {
      html.push(`<input id="waitNameInput" placeholder="대기자 이름 입력" />`);
      html.push(`<button id="addWaitBtn" class="btn primary" style="width:100%; margin-bottom:12px;">+ 대기 추가</button>`);
    } else {
      html.push(`<div class="badge" style="margin-bottom:12px;">대기 관리는 admin만 가능합니다</div>`);
    }

    if (displayWaiting.length === 0) {
      html.push(`
        <div class="row">
          <div class="left">
            <div>대기자 없음</div>
          </div>
        </div>
      `);
    } else {
      sortWaitingAscending(displayWaiting).forEach((w, index) => {
        const isSel = selected === w.id;
        const start = getWaitingTimerStartMs(w);
        html.push(`
          <div class="row ${isSel ? "selected" : ""}" data-wid="${w.id}" style="cursor:pointer;">
            <div class="left">
              <div style="font-weight:900;">${escapeHtml(w.name)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="time-chip" data-timer="wait" data-start="${start}" data-target="wait:${w.id}">00:00:00</span>
              ${
                canManageLayout()
                  ? `<button class="btn small danger" data-del-w="${w.id}">삭제</button>`
                  : ``
              }
            </div>
          </div>
        `);
      });
    }

    panelContent.innerHTML = html.join("");

    if (canManageLayout()) {
      const addBtn = document.getElementById("addWaitBtn");
      const input = document.getElementById("waitNameInput");

      addBtn?.addEventListener("click", () => {
        const name = String(input?.value || "").trim();
        if (!name) return;
        addWaiting(name);
      });

      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn?.click();
      });
    }

    panelContent.querySelectorAll("[data-wid]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-del-w]")) return;
        const wid = row.getAttribute("data-wid");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        ui.selectedSeatId = null;
        renderPanel();
        updateTimers();
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
    const waitingAll = getWaitingListForDisplay();

    const left = [];
    const seatCount = eventState.seats.length;
    const waitCount = waitingAll.length;
    const metaActionsHidden = !canManageLayout();

    left.push(`
      <div class="global-meta">
        <div class="global-meta-left">
          <span class="hint-pill">SEAT: ${seatCount}</span>
          <span class="hint-pill">WAIT: ${waitCount}</span>
        </div>
        <div class="global-meta-actions ${metaActionsHidden ? "hidden" : ""}" aria-hidden="${metaActionsHidden ? "true" : "false"}">
          <button type="button" id="globalUndoToolbarBtn" class="pill-inline seat-meta-btn seat-meta-btn--undo" ${ui.lastUndoAction ? "" : "disabled"}>되돌리기</button>
        </div>
      </div>
    `);

    left.push(`
      <div class="global-form-seat-add ${metaActionsHidden ? "hidden" : ""}" aria-hidden="${metaActionsHidden ? "true" : "false"}">
        <div class="seat-add-one-row">
          <div class="seat-add-leading" aria-hidden="true"></div>
          <button type="button" id="addSeatToolbarBtn" class="pill-inline primary seat-meta-btn seat-add-action-btn" title="+ Seat 추가">추가</button>
        </div>
      </div>
    `);

    left.push(`
      <div class="seat-sort-row">
        <button id="sortSeatOrderBtn" class="pill-inline ${ui.seatSortMode === "seat" ? "active" : ""}" type="button">Seat순</button>
        <button id="sortSeatTimeBtn" class="pill-inline ${ui.seatSortMode === "time" ? "active" : ""}" type="button">시간순</button>
      </div>
    `);

    left.push(`<div class="global-list layout-seat-tab-list">`);

    if (eventState.seats.length === 0) {
      left.push(`
        <div class="empty-panel">현재 이벤트(${escapeHtml(EVENT_ID)})에 Seat이 없습니다.</div>
      `);
    } else {
      getSortedSeats(eventState.seats).forEach((s) => {
        const isSel = ui.selectedSeatId === s.id;
        const hasPerson = !isEmptyPerson(s.person);
        const start = hasPerson ? (s.seatedAt || Date.now()) : null;

        left.push(`
            <div class="seat-manage-row ${isSel ? "selected" : ""}" data-sid="${s.id}" style="cursor:pointer;">
              <div class="seat-manage-main seat-manage-main--oneline">
                <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
                  <span class="seat-manage-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
                  <span class="seat-manage-name ${isEmptyPerson(s.person) ? "is-empty" : ""}">
                    ${escapeHtml(s.person)}
                  </span>
                </div>
                <div class="seat-inline-actions">
                  ${
                    hasPerson
                      ? `<span class="time-chip"
                          data-timer="seat"
                          data-start="${start}"
                          data-target="seat:${s.id}">
                          00:00:00
                        </span>`
                      : `<span class="seat-manage-empty-dash">-</span>`
                  }
                  ${
                    canManageLayout()
                      ? `
                      ${
                        hasPerson
                          ? `<button class="pill-inline warn" type="button" data-clear-seat="${s.id}">비우기</button>`
                          : ``
                      }
                      <button class="pill-inline danger" type="button" data-del="${s.id}">삭제</button>
                      `
                      : ``
                  }
                </div>
              </div>
            </div>
          `);
      });
    }

    left.push(`</div>`);

    panelContent.innerHTML = left.join("");

    const globalUndoToolbarBtn = document.getElementById("globalUndoToolbarBtn");
    if (globalUndoToolbarBtn) {
      globalUndoToolbarBtn.onclick = () => {
        void undoLastAction();
      };
    }

    const addSeatToolbarBtn = document.getElementById("addSeatToolbarBtn");
    if (addSeatToolbarBtn) {
      addSeatToolbarBtn.onclick = () => {
        addSeat();
      };
    }

    const sortSeatOrderBtn = document.getElementById("sortSeatOrderBtn");
if (sortSeatOrderBtn) {
  sortSeatOrderBtn.onclick = () => {
    ui.seatSortMode = "seat";
    renderPanel();
    updateTimers();
  };
}

const sortSeatTimeBtn = document.getElementById("sortSeatTimeBtn");
if (sortSeatTimeBtn) {
  sortSeatTimeBtn.onclick = () => {
    ui.seatSortMode = "time";
    renderPanel();
    updateTimers();
  };
}

    panelContent.querySelectorAll("[data-sid]").forEach((el) => {
  el.addEventListener("click", (e) => {
    if (
      e.target &&
      (
        e.target.closest("[data-del]") ||
        e.target.closest("[data-clear-seat]") ||
        e.target.closest(".time-chip") ||
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
      btn.addEventListener("click", async (e) => {
  e.stopPropagation();
  await clearSeat(btn.getAttribute("data-clear-seat"));
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

        eventState.version = next.version || 2;
        eventState.eventId = next.eventId || EVENT_ID;
        eventState.boxId = next.boxId || BOX_ID;
        eventState.nextSeatNo = next.nextSeatNo || 1;
        eventState.nextSeatOrder = next.nextSeatOrder || 1;
        eventState.seats = Array.isArray(next.seats) ? next.seats : [];
        eventState.updatedAt = nextUpdatedAt || Date.now();

        applyGlobalSeatMapToEventSeats();

        render();
        void healAndPersistState("event_snapshot");
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

        waitingState.version = nextW.version || 2;
        waitingState.waiting = Array.isArray(nextW.waiting)
          ? nextW.waiting.map((raw) => normalizeWaitingEntry(raw)).filter(Boolean)
          : [];
        waitingState.updatedAt = nextUpdatedAt || Date.now();

        render();
        void healAndPersistState("waiting_snapshot");
      },
      (err) => {
        console.error("WAITING_REF snapshot error:", err);
      }
    );

  }

  async function init() {
    if (hasInitialized) return;
    hasInitialized = true;

    await refreshCachedEventCardTitle();

    const [remoteEvent, remoteWaiting] = await Promise.all([
      loadEventStateRemote(),
      loadWaitingStateRemote()
    ]);

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

    const bootSaves = [];
    // layout_events 는 Rules 상 관리자만 쓰기 가능 — 비관리자는 빈 문서 생성 시도 시 permission 오류
    if (!remoteEvent && isAdminUser) bootSaves.push(saveEventState());
    if (!remoteWaiting) bootSaves.push(saveWaitingState());
    if (bootSaves.length) await Promise.all(bootSaves);

    waitingState.waiting = waitingState.waiting
      .map((w) => normalizeWaitingEntry(w))
      .filter(Boolean);

    await healAndPersistState("init");

    bindTournamentGlobalSeatsMerge();
    applyGlobalSeatMapToEventSeats();

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
        location.href = `./index.html?tournamentId=${encodeURIComponent(TOURNAMENT_ID)}`;
        return;
      }

      sessionStorage.removeItem("eventId");
      sessionStorage.removeItem("boxId");
      location.href = "./hub.html";
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
    currentUser = null;
    currentUserProfile = null;
    isAdminUser = false;

    if (stopMyNotificationWatch) {
      stopMyNotificationWatch();
      stopMyNotificationWatch = null;
    }

    resetSeatNotificationUi();
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

  bindMyNotificationWatch();

  if (!hasInitialized) {
    await init();
  }

  await showPendingSeatNotificationOnce();
  render();
});
})();
