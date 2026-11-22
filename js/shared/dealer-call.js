/**
 * 운영자 → 대기 중인 딜러 "호출".
 *
 * 운영자가 통합 배치도 대기 목록에서 [호출]을 누르면 layout_calls/{딜러uid} 문서를 쓴다.
 *  - 서버(functions notifyDealerCall)가 배치 알림과 같은 방식(FCM data-only → SW 알림)으로 푸시를 보낸다.
 *  - 딜러 화면(index.html / global-layout.html)은 이 문서를 실시간으로 보고 있다가
 *    배치 알림과 같은 모달 + 비프음 + 진동으로 알린다. [확인]을 누르면 acknowledged 로 바뀐다.
 * 배치 알림 문서(layout_notifications)와 섞으면 배치 상태가 지워지므로 별도 문서를 쓴다.
 */
import { db } from "../firebase.js";
import { doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { holdAlertAudioSession, playIosMediaBeep } from "./alert-audio-session.js";

/** 이 시간 지난 호출은 화면에 띄우지 않는다(서버 푸시도 같은 기준) */
export const DEALER_CALL_MAX_AGE_MS = 10 * 60 * 1000;
const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

function callRef(uid) {
  return doc(db, "layout_calls", String(uid || "").trim());
}

/** 운영자: 딜러 호출 */
export async function sendDealerCall({ uid = "", name = "", tournamentId = "", calledByUid = "", calledByName = "" } = {}) {
  const target = String(uid || "").trim();
  if (!target) throw new Error("no_uid");
  const now = Date.now();
  await setDoc(callRef(target), {
    type: "dealer_call",
    uid: target,
    name: String(name || "").trim(),
    tournamentId: String(tournamentId || "").trim(),
    calledAt: now,
    calledByUid: String(calledByUid || "").trim(),
    calledByName: String(calledByName || "").trim() || "운영자",
    acknowledged: false,
    acknowledgedAt: null,
    updatedAt: now
  });
  return now;
}

/* ---------------- 딜러 화면 ---------------- */

let stopWatch = null;
let watchUid = "";
let shownKey = "";
let soundTimer = null;
let dismissTimer = null;
let audioCtx = null;

function injectStyles() {
  if (document.getElementById("dealerCallModalStyle")) return;
  const style = document.createElement("style");
  style.id = "dealerCallModalStyle";
  style.textContent = `
    .dealer-call-backdrop{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;
      padding:16px;background:rgba(0,0,0,.6)}
    .dealer-call-backdrop.show{display:flex}
    .dealer-call-card{width:min(360px,100%);border-radius:16px;padding:22px 20px 18px;background:#1b1d22;color:#f2f4f8;
      border:2px solid #f59f00;box-shadow:0 12px 40px rgba(0,0,0,.5);text-align:center;
      animation:dealer-call-pulse 1s ease-in-out infinite}
    .dealer-call-card h2{margin:0 0 10px;font-size:20px;color:#ffd43b}
    .dealer-call-card p{margin:0 0 18px;line-height:1.6;font-size:15px}
    .dealer-call-card button{width:100%;min-height:46px;border:0;border-radius:10px;background:#f59f00;color:#111;
      font-size:16px;font-weight:800;cursor:pointer}
    @keyframes dealer-call-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,159,0,.55)}50%{box-shadow:0 0 0 10px rgba(245,159,0,0)}}
  `;
  document.head.appendChild(style);
}

function ensureModal() {
  injectStyles();
  let overlay = document.getElementById("dealerCallModal");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "dealerCallModal";
  overlay.className = "dealer-call-backdrop";
  overlay.innerHTML = `
    <div class="dealer-call-card" role="alertdialog" aria-labelledby="dealerCallTitle">
      <h2 id="dealerCallTitle">호출 알림</h2>
      <p id="dealerCallMessage"></p>
      <button id="dealerCallOkBtn" type="button">확인</button>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function beep() {
  // 아이폰: 무음 스위치를 무시하는 <audio> 재생
  if (playIosMediaBeep("call")) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    holdAlertAudioSession();
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.9, now + 0.01);
    gain.gain.setValueAtTime(0.9, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    gain.connect(audioCtx.destination);
    const osc = audioCtx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(2600, now);
    osc.frequency.setValueAtTime(2000, now + 0.18);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.37);
  } catch {
    /* noop */
  }
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* noop */
  }
}

function soundLoopAllowed() {
  try {
    return localStorage.getItem(SOUND_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function stopAlerting() {
  if (soundTimer) clearInterval(soundTimer);
  soundTimer = null;
  vibrate(0);
}

function hideModal() {
  document.getElementById("dealerCallModal")?.classList.remove("show");
  stopAlerting();
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
}

function showModal(data, uid) {
  const overlay = ensureModal();
  const who = String(data.calledByName || "").trim() || "운영자";
  const msg = document.getElementById("dealerCallMessage");
  if (msg) msg.textContent = `${who} 님이 호출했습니다.\n운영석으로 와 주세요.`;
  if (msg) msg.style.whiteSpace = "pre-line";
  overlay.classList.add("show");
  // 배치 알림과 같은 방식: 뜨는 순간 비프+진동, 소리 허용 사용자는 확인할 때까지 1초마다 반복
  beep();
  vibrate([400, 200, 400]);
  stopAlerting();
  if (soundLoopAllowed()) {
    soundTimer = setInterval(() => {
      beep();
      vibrate([400, 200, 400]);
    }, 1000);
  }
  const ok = document.getElementById("dealerCallOkBtn");
  if (ok) {
    ok.onclick = async () => {
      hideModal();
      try {
        await setDoc(callRef(uid), { acknowledged: true, acknowledgedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
      } catch (err) {
        console.warn("dealer call ack:", err?.code || err);
      }
    };
  }
  // 오래 방치되면 자동으로 닫는다
  if (dismissTimer) clearTimeout(dismissTimer);
  const remaining = Number(data.calledAt || 0) + DEALER_CALL_MAX_AGE_MS - Date.now();
  dismissTimer = setTimeout(hideModal, Math.max(0, remaining));
}

function applySnap(snap, uid) {
  if (!snap.exists()) {
    hideModal();
    return;
  }
  const data = snap.data() || {};
  const calledAt = Number(data.calledAt || 0);
  const key = `${uid}|${calledAt}`;
  if (data.acknowledged === true || !calledAt || Date.now() - calledAt > DEALER_CALL_MAX_AGE_MS) {
    if (shownKey === key || data.acknowledged === true) hideModal();
    return;
  }
  if (shownKey === key) return;
  // 화면이 보일 때만 띄운다 — 백그라운드면 OS 알림(FCM)이 대신 뜨고, 돌아왔을 때 다시 확인
  if (document.visibilityState !== "visible") return;
  shownKey = key;
  showModal(data, uid);
}

/** 딜러(로그인 사용자) 화면: 내 호출 구독. 같은 uid 로 다시 부르면 무시. */
export function bindMyDealerCallWatch(user) {
  const uid = String(user?.uid || "").trim();
  if (!uid || uid === watchUid) return;
  if (stopWatch) stopWatch();
  watchUid = uid;
  shownKey = "";
  let lastSnap = null;
  stopWatch = onSnapshot(
    callRef(uid),
    (snap) => {
      lastSnap = snap;
      applySnap(snap, uid);
    },
    (err) => console.warn("dealer call watch:", err?.code || err)
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && lastSnap && watchUid === uid) applySnap(lastSnap, uid);
  });
}

export function stopMyDealerCallWatch() {
  if (stopWatch) stopWatch();
  stopWatch = null;
  watchUid = "";
  hideModal();
}
