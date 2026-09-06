/**
 * 비상 표시(Seat Alert) — 통합 배치도·일반 배치도 공통.
 *
 * admin/운영 권한자가 seat(캔버스 박스 / 대기·배치 패널 행 / 모바일 행)를 길게 누르면
 * tournaments/{tid}/global_seats/{doc}.alertActive 를 토글한다. 켜지면 그 좌석이 빨간색으로
 * 깜박이고(다른 admin 화면 포함), 다른 admin 기기에서는 짧은 소리+진동이 울린다.
 * 다시 길게 누르면 해제. 별도 입력창은 없다.
 *
 * 렌더 파이프라인을 건드리지 않으려고, 스냅샷/주기적으로 DOM 을 훑어 클래스만 토글한다.
 */
import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE_PX = 12;
const CUE_MAX_AGE_MS = 15000;
const CUE_THROTTLE_MS = 1500;
const REPAINT_INTERVAL_MS = 500;
const CONSUME_WINDOW_MS = 800;

/** 좌석 1개를 가리키는 DOM 요소 후보 (통합/일반 배치도 · 캔버스/패널/모바일) */
const SEAT_EL_SELECTOR = [
  ".seat-box[data-seat-id]",
  ".seat-box[data-seatid]",
  "[data-select-seat]",
  ".seat-manage-row[data-sid]",
  "[data-mobile-seat]"
].join(",");

function seatIdFromEl(el) {
  if (!el || !el.getAttribute) return "";
  return String(
    el.getAttribute("data-seat-id") ||
      el.getAttribute("data-seatid") ||
      el.getAttribute("data-select-seat") ||
      el.getAttribute("data-sid") ||
      el.getAttribute("data-mobile-seat") ||
      ""
  ).trim();
}

export const SEAT_ALERT_CLASS = "seat-alert-on";

/** 렌더러에서 좌석 행/박스 클래스에 넣을지 판단 — 운영 권한자에게만 보인다. */
export function seatShowsAlert(seat, canManage) {
  return canManage === true && !!seat && seat.alertActive === true;
}

let activeTid = "";
let activeHandle = null;

export function initSeatAlerts({ db, tournamentId, getUid, canManage, onLocalToggle } = {}) {
  const tid = String(tournamentId || "").trim();
  if (!db || !tid) return activeHandle || { stop() {} };
  if (activeHandle && activeTid === tid) return activeHandle;
  activeHandle?.stop?.();
  activeTid = tid;

  /** seatId -> { docId, active, at, by } */
  const state = new Map();
  let lastCueAt = 0;
  let audioCtx = null;
  let firedAt = 0;
  let consumeNextClick = false;

  const myUid = () => String(getUid?.() || "").trim();
  const canSee = () => {
    try {
      return canManage?.() === true;
    } catch {
      return false;
    }
  };

  function playCue() {
    const now = Date.now();
    if (now - lastCueAt < CUE_THROTTLE_MS) return;
    lastCueAt = now;
    try {
      navigator.vibrate?.([140, 70, 140]);
    } catch {
      /* noop */
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const start = audioCtx.currentTime;
      for (let i = 0; i < 2; i++) {
        const s = start + i * 0.28;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, s);
        gain.gain.linearRampToValueAtTime(0.35, s + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.24);
        gain.connect(audioCtx.destination);
        const osc = audioCtx.createOscillator();
        osc.type = "square";
        osc.frequency.setValueAtTime(1174.7, s);
        osc.connect(gain);
        osc.start(s);
        osc.stop(s + 0.26);
      }
    } catch {
      /* noop */
    }
  }

  function repaint() {
    const show = canSee();
    document.querySelectorAll(SEAT_EL_SELECTOR).forEach((el) => {
      const sid = seatIdFromEl(el);
      const on = show && !!(sid && state.get(sid)?.active);
      if (el.classList.contains("seat-alert-on") !== on) {
        el.classList.toggle("seat-alert-on", on);
      }
    });
  }

  const stopSnap = onSnapshot(
    collection(db, "tournaments", tid, "global_seats"),
    (snap) => {
      const uid = myUid();
      let cue = false;
      const seen = new Set();
      snap.forEach((d) => {
        const data = d.data() || {};
        const active = data.alertActive === true;
        const at = Number(data.alertAt || 0) || 0;
        const by = String(data.alertBy || "").trim();
        const rec = { docId: d.id, active, at, by };
        // seatId 와 Firestore 문서 ID 양쪽으로 색인 — DOM 요소가 어느 쪽 값을
        // 들고 있어도(getGlobalSeatRowKey 는 seatId 없으면 docId 를 준다) 찾히도록.
        const keys = [String(data.seatId || "").trim(), String(d.id || "").trim()].filter(Boolean);
        let wasActive = false;
        for (const k of keys) {
          if (state.get(k)?.active) wasActive = true;
          state.set(k, rec);
          seen.add(k);
        }
        if (active && !wasActive && by && by !== uid && Date.now() - at < CUE_MAX_AGE_MS) {
          cue = true;
        }
      });
      for (const k of [...state.keys()]) {
        if (!seen.has(k)) state.delete(k);
      }
      repaint();
      if (cue && canSee()) playCue();
    },
    (err) => console.error("seat-alert snapshot error:", err)
  );

  let press = null;
  function clearPress() {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
  }

  async function fire(sid) {
    firedAt = Date.now();
    consumeNextClick = true;
    setTimeout(() => {
      consumeNextClick = false;
    }, CONSUME_WINDOW_MS);
    try {
      onLocalToggle?.();
    } catch {
      /* noop */
    }

    const rec = state.get(sid);
    if (!rec?.docId) {
      console.warn("seat-alert: seat doc not found for", sid, "(is the seat saved?)");
      return;
    }
    const next = !rec.active;
    const optimistic = { ...rec, active: next, at: Date.now(), by: myUid() };
    state.set(sid, optimistic);
    if (rec.docId && rec.docId !== sid) state.set(rec.docId, optimistic);
    repaint();
    try {
      navigator.vibrate?.(next ? 30 : 12);
    } catch {
      /* noop */
    }
    try {
      await setDoc(
        doc(db, "tournaments", tid, "global_seats", rec.docId),
        {
          alertActive: next,
          alertAt: Date.now(),
          alertBy: myUid(),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("seat-alert toggle write error:", err);
      state.set(sid, rec);
      if (rec.docId && rec.docId !== sid) state.set(rec.docId, rec);
      repaint();
      alert("비상 표시 저장에 실패했습니다(권한 또는 연결 확인).");
    }
  }

  function onDown(e) {
    clearPress();
    if (!canSee()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = e.target?.closest?.(SEAT_EL_SELECTOR);
    if (!el) return;
    const sid = seatIdFromEl(el);
    if (!sid) return;
    press = {
      sid,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        const p = press;
        clearPress();
        if (p) void fire(p.sid);
      }, LONG_PRESS_MS)
    };
  }

  function onMove(e) {
    if (!press) return;
    if (
      Math.abs(e.clientX - press.x) > MOVE_TOLERANCE_PX ||
      Math.abs(e.clientY - press.y) > MOVE_TOLERANCE_PX
    ) {
      clearPress();
    }
  }

  function onUp(e) {
    clearPress();
    if (
      e &&
      Date.now() - firedAt < CONSUME_WINDOW_MS &&
      e.target?.closest?.(SEAT_EL_SELECTOR)
    ) {
      // 길게 눌러 토글한 직후의 pointerup 이 좌석 선택/이동 로직까지 타지 않도록
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }
  }

  function onClickCapture(e) {
    if (!consumeNextClick && Date.now() - firedAt >= CONSUME_WINDOW_MS) return;
    // 방금 길게 누른 좌석 요소의 클릭만 삼킨다 (무관한 버튼 클릭까지 막지 않도록)
    if (!e.target?.closest?.(SEAT_EL_SELECTOR)) return;
    consumeNextClick = false;
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    e.preventDefault();
  }

  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerup", onUp, true);
  document.addEventListener("pointercancel", onUp, true);
  document.addEventListener("click", onClickCapture, true);
  window.addEventListener("blur", () => clearPress());

  const repaintTimer = setInterval(repaint, REPAINT_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") repaint();
  });

  activeHandle = {
    repaint,
    stop() {
      try {
        stopSnap();
      } catch {
        /* noop */
      }
      clearInterval(repaintTimer);
      clearPress();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("click", onClickCapture, true);
      activeTid = "";
      activeHandle = null;
    }
  };
  return activeHandle;
}
