import { GL } from "./state.js";
import { escapeHtml, isEmptyPerson } from "./utils.js";
import { canViewGlobalLayoutSeatHistory } from "./ops-access.js";
import {
  getEventCardIdFromRecord,
  parseEventInstanceDocId
} from "../shared/tournament-event-instance.js";
import {
  SEAT_HISTORY_LONG_PRESS_MS,
  findGlobalSeatByAnyKey,
  formatSeatHistoryRange,
  getSeatHistoryView,
  seatHistoryReasonLabel
} from "./seat-history.js";

const MOVE_CANCEL_PX = 14;

function getEls() {
  const root = document.getElementById("globalSeatHistoryModal");
  if (!root) return null;
  return {
    root,
    title: document.getElementById("globalSeatHistoryTitle"),
    cardId: document.getElementById("globalSeatHistoryCardId"),
    list: document.getElementById("globalSeatHistoryList"),
    empty: document.getElementById("globalSeatHistoryEmpty")
  };
}

function resolveSeatCardId(seat) {
  if (!seat) return "";
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  if (!eventId) return "";
  const parsed = parseEventInstanceDocId(eventId);
  return parsed?.cardId || getEventCardIdFromRecord({ id: eventId }) || eventId;
}

function renderHistoryList(view) {
  const rows = [];
  if (view.current) {
    rows.push(`
      <li class="global-seat-history-row global-seat-history-row--current">
        <div class="global-seat-history-name">${escapeHtml(view.current.person)}</div>
        <div class="global-seat-history-time">${escapeHtml(formatSeatHistoryRange(view.current.seatedAt, 0))}</div>
        <span class="global-seat-history-badge">${escapeHtml(seatHistoryReasonLabel("current"))}</span>
      </li>
    `);
  }
  for (const item of view.past) {
    rows.push(`
      <li class="global-seat-history-row">
        <div class="global-seat-history-name">${escapeHtml(item.person || "-")}</div>
        <div class="global-seat-history-time">${escapeHtml(formatSeatHistoryRange(item.seatedAt, item.leftAt))}</div>
        <span class="global-seat-history-badge">${escapeHtml(seatHistoryReasonLabel(item.reason))}</span>
      </li>
    `);
  }
  return rows.join("");
}

export function openSeatHistoryModal(seatKey = "") {
  const els = getEls();
  if (!els) return;

  const seat = findGlobalSeatByAnyKey(seatKey);
  const view = getSeatHistoryView(seat);
  const seatLabel = view.label || seatKey || "-";

  if (els.title) {
    els.title.textContent = `SEAT ${seatLabel} 배치 이력`;
  }
  if (els.cardId) {
    const cardId = resolveSeatCardId(seat);
    els.cardId.textContent = cardId ? `카드 ID: ${cardId}` : "";
    els.cardId.hidden = !cardId;
  }

  const hasRows = Boolean(view.current) || view.past.length > 0;
  if (els.list) {
    els.list.innerHTML = hasRows ? renderHistoryList(view) : "";
    els.list.hidden = !hasRows;
  }
  if (els.empty) {
    els.empty.hidden = hasRows;
  }

  els.root.classList.add("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("global-seat-edit-modal-open");
}

export function closeSeatHistoryModal() {
  const els = getEls();
  if (!els) return;
  els.root.classList.remove("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("global-seat-edit-modal-open");
}

/** 배치된 Seat — 사람 이름 영역 클릭 시 이력 모달 (직접 허용 운영자 포함) */
export function tryOpenSeatHistoryFromPersonClick(e, seatKey = "") {
  if (!canViewGlobalLayoutSeatHistory()) return false;
  const key = String(seatKey || "").trim();
  if (!key) return false;
  const seat = findGlobalSeatByAnyKey(key);
  if (!seat || isEmptyPerson(String(seat.person || "").trim())) return false;
  const onPerson = e.target.closest(
    ".seat-person:not(.is-empty), .seat-manage-name, .mobile-seat-person"
  );
  if (!onPerson) return false;
  openSeatHistoryModal(key);
  return true;
}

export function initGlobalSeatHistoryModal() {
  const els = getEls();
  if (!els || els.root.dataset.bound === "1") return;
  els.root.dataset.bound = "1";

  els.root.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-seat-history]")) closeSeatHistoryModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.root.classList.contains("global-seat-edit-modal--open")) {
      closeSeatHistoryModal();
    }
  });
}

function resolveSeatKeyFromEl(el) {
  if (!el) return "";
  return (
    String(el.getAttribute("data-seat-id") || "").trim() ||
    String(el.getAttribute("data-mobile-seat") || "").trim() ||
    String(el.getAttribute("data-select-seat") || "").trim()
  );
}

/** Seat 박스·모바일 행·패널 행 — 길게 누르거나 우클릭 시 이력 모달 */
export function wireSeatHistoryLongPress(root, options = {}) {
  if (!root || root.dataset.seatHistoryWired === "1") return;
  root.dataset.seatHistoryWired = "1";

  const canOpen = typeof options.canOpen === "function" ? options.canOpen : () => true;
  let timer = 0;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let armedEl = null;

  function cancelLongPress() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  function resetPointer() {
    cancelLongPress();
    armedEl = null;
    pointerId = null;
  }

  function openFromEl(el) {
    const key = resolveSeatKeyFromEl(el);
    if (!key || !canOpen()) return;
    GL.suppressSeatClickUntil = Date.now() + 450;
    try {
      navigator.vibrate?.(12);
    } catch {
      /* ignore */
    }
    openSeatHistoryModal(key);
  }

  root.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const seatEl = e.target.closest("[data-seat-id], [data-mobile-seat], [data-select-seat]");
      if (!seatEl || e.target.closest("button, input, label, a")) return;
      cancelLongPress();
      armedEl = seatEl;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      timer = window.setTimeout(() => {
        timer = 0;
        const target = armedEl;
        resetPointer();
        if (target) openFromEl(target);
      }, SEAT_HISTORY_LONG_PRESS_MS);
    },
    { passive: true }
  );

  root.addEventListener(
    "pointermove",
    (e) => {
      if (!timer || e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_CANCEL_PX) resetPointer();
    },
    { passive: true }
  );

  root.addEventListener("pointerup", resetPointer);
  root.addEventListener("pointercancel", resetPointer);

  root.addEventListener("contextmenu", (e) => {
    const seatEl = e.target.closest("[data-seat-id], [data-mobile-seat], [data-select-seat]");
    if (!seatEl || e.target.closest("button, input, label, a")) return;
    e.preventDefault();
    openFromEl(seatEl);
  });
}
