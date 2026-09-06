/**
 * 좌석 상태 표시(Seat Alert) — 통합 배치도·일반 배치도 공통.
 *
 * admin/운영 권한자가 seat(캔버스 박스 / 배치 패널 행 / 모바일 행)를 길게 누르면
 * 선택 모달이 뜬다 — [비상](빨강) / [Break](파랑). 고르면
 * tournaments/{tid}/global_seats/{doc}.alertKind 가 바뀌고, 그 좌석이 해당 색으로
 * 깜박인다(다른 admin 화면 포함). 같은 항목을 다시 고르면 해제. 다른 admin 기기에서는
 * 켜질 때 짧은 소리+진동.
 *
 * 렌더러가 seatAlertClass() 로 직접 클래스를 붙이고, 이 모듈은 backstop 으로
 * 스냅샷/주기 리페인트도 한다.
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

const KIND_CLASS = {
  emergency: "seat-alert-on seat-alert-emergency",
  break: "seat-alert-on seat-alert-break"
};
const ALL_ALERT_CLASSES = ["seat-alert-on", "seat-alert-emergency", "seat-alert-break"];

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

/** 좌석 객체 → 현재 상태("" | "emergency" | "break"). 구버전(alertActive) 호환. */
export function seatAlertKind(seat) {
  const k = String(seat?.alertKind || "").trim();
  if (k === "emergency" || k === "break") return k;
  return seat?.alertActive === true ? "emergency" : "";
}

/** 렌더러에서 좌석 행/박스에 넣을 클래스 문자열 — 운영 권한자에게만 보인다. */
export function seatAlertClass(seat, canManage) {
  if (canManage !== true || !seat) return "";
  return KIND_CLASS[seatAlertKind(seat)] || "";
}

/** 구 API 호환 (boolean) */
export function seatShowsAlert(seat, canManage) {
  return !!seatAlertClass(seat, canManage);
}

let activeTid = "";
let activeHandle = null;

export function initSeatAlerts({ db, tournamentId, getUid, canManage, onLocalToggle } = {}) {
  const tid = String(tournamentId || "").trim();
  if (!db || !tid) return activeHandle || { stop() {} };
  if (activeHandle && activeTid === tid) return activeHandle;
  activeHandle?.stop?.();
  activeTid = tid;

  /** seatId(및 docId) -> { docId, kind, at, by } */
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

  function applyClasses(el, kind) {
    const want = kind ? KIND_CLASS[kind].split(" ") : [];
    for (const c of ALL_ALERT_CLASSES) {
      const on = want.includes(c);
      if (el.classList.contains(c) !== on) el.classList.toggle(c, on);
    }
  }

  function repaint() {
    const show = canSee();
    document.querySelectorAll(SEAT_EL_SELECTOR).forEach((el) => {
      const sid = seatIdFromEl(el);
      const kind = show && sid ? state.get(sid)?.kind || "" : "";
      applyClasses(el, kind);
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
        const kind = seatAlertKind(data);
        const at = Number(data.alertAt || 0) || 0;
        const by = String(data.alertBy || "").trim();
        const rec = { docId: d.id, kind, at, by };
        const keys = [String(data.seatId || "").trim(), String(d.id || "").trim()].filter(Boolean);
        let hadKind = false;
        for (const k of keys) {
          if (state.get(k)?.kind) hadKind = true;
          state.set(k, rec);
          seen.add(k);
        }
        if (kind && !hadKind && by && by !== uid && Date.now() - at < CUE_MAX_AGE_MS) {
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

  async function writeKind(sid, kind) {
    const rec = state.get(sid);
    if (!rec?.docId) {
      console.warn("seat-alert: seat doc not found for", sid, "(is the seat saved?)");
      alert("좌석 정보를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const nextKind = rec.kind === kind ? "" : kind;
    const optimistic = { ...rec, kind: nextKind, at: Date.now(), by: myUid() };
    state.set(sid, optimistic);
    if (rec.docId && rec.docId !== sid) state.set(rec.docId, optimistic);
    repaint();
    try {
      navigator.vibrate?.(nextKind ? 30 : 12);
    } catch {
      /* noop */
    }
    try {
      await setDoc(
        doc(db, "tournaments", tid, "global_seats", rec.docId),
        {
          alertKind: nextKind,
          alertActive: nextKind !== "",
          alertAt: Date.now(),
          alertBy: myUid(),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("seat-alert write error:", err);
      state.set(sid, rec);
      if (rec.docId && rec.docId !== sid) state.set(rec.docId, rec);
      repaint();
      alert("좌석 상태 저장에 실패했습니다(권한 또는 연결 확인).");
    }
  }

  // ── 선택 모달 ────────────────────────────────────────────────
  let modalEl = null;
  function closeModal() {
    modalEl?.remove();
    modalEl = null;
    document.removeEventListener("keydown", onModalKey, true);
  }
  function onModalKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeModal();
    }
  }
  function openModal(sid) {
    closeModal();
    const cur = state.get(sid)?.kind || "";
    const el = document.createElement("div");
    el.className = "seat-alert-modal-backdrop";
    el.innerHTML = `
      <div class="seat-alert-modal" role="dialog" aria-modal="true" aria-label="좌석 상태 표시">
        <div class="seat-alert-modal-title">좌석 상태 표시</div>
        <div class="seat-alert-modal-status">${
          cur === "emergency" ? "지금: 비상 (다시 누르면 해제)" : cur === "break" ? "지금: Break (다시 누르면 해제)" : "표시할 상태를 고르세요"
        }</div>
        <div class="seat-alert-modal-actions">
          <button type="button" class="seat-alert-modal-btn is-emergency ${cur === "emergency" ? "is-active" : ""}" data-kind="emergency">비상</button>
          <button type="button" class="seat-alert-modal-btn is-break ${cur === "break" ? "is-active" : ""}" data-kind="break">Break</button>
        </div>
        <button type="button" class="seat-alert-modal-close" data-close>닫기</button>
      </div>
    `;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target === el || e.target.closest("[data-close]")) {
        closeModal();
        return;
      }
      const btn = e.target.closest("[data-kind]");
      if (!btn) return;
      const kind = btn.getAttribute("data-kind");
      closeModal();
      void writeKind(sid, kind);
    });
    document.body.appendChild(el);
    modalEl = el;
    document.addEventListener("keydown", onModalKey, true);
  }

  // ── 길게 누르기 ──────────────────────────────────────────────
  let press = null;
  function clearPress() {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
  }

  function trigger(sid) {
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
    try {
      navigator.vibrate?.(18);
    } catch {
      /* noop */
    }
    openModal(sid);
  }

  function onDown(e) {
    clearPress();
    if (!canSee()) return;
    if (modalEl) return;
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
        if (p) trigger(p.sid);
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
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }
  }

  function onClickCapture(e) {
    if (!consumeNextClick && Date.now() - firedAt >= CONSUME_WINDOW_MS) return;
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
      closeModal();
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
