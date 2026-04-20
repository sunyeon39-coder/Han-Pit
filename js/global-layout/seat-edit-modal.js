import { getSeatById } from "./panel-ui.js";
import { applyGlobalSeatRename } from "./firestore-ops.js";
import { isValidSeatLabel, isValidLayoutRouteIdPart, looksLikeDisplayTitleNotId, escapeHtml } from "./utils.js";
import { fetchTournamentEvents } from "./tournament-events.js";
import { resolveBoxIdForEventId } from "./event-box-resolve.js";

let currentSeatId = "";
/** openSeatEditModal 마지막 fetch 목록 — 카드 선택 시 Box 추론에 사용 */
let seatEditModalEventsCache = [];
let eventPickDocListener = null;

function getEls() {
  const root = document.getElementById("globalSeatEditModal");
  if (!root) return null;
  return {
    root,
    label: document.getElementById("globalSeatEditLabel"),
    eventId: document.getElementById("globalSeatEditEventId"),
    eventPick: document.getElementById("globalSeatEditEventPick"),
    eventTrigger: document.getElementById("globalSeatEditEventTrigger"),
    eventTriggerText: document.getElementById("globalSeatEditEventTriggerText"),
    eventList: document.getElementById("globalSeatEditEventList"),
    boxId: document.getElementById("globalSeatEditBoxId"),
    seatIdDisplay: document.getElementById("globalSeatEditSeatIdDisplay"),
    saveBtn: document.getElementById("globalSeatEditSave")
  };
}

function detachEventPickDocListener() {
  if (eventPickDocListener) {
    document.removeEventListener("click", eventPickDocListener, true);
    eventPickDocListener = null;
  }
}

function closeEventPickList() {
  const els = getEls();
  if (!els?.eventList || !els.eventTrigger) return;
  els.eventList.hidden = true;
  els.eventTrigger.setAttribute("aria-expanded", "false");
  detachEventPickDocListener();
}

function openEventPickList() {
  const els = getEls();
  if (!els?.eventList || !els.eventTrigger) return;
  els.eventList.hidden = false;
  els.eventTrigger.setAttribute("aria-expanded", "true");
  detachEventPickDocListener();
  eventPickDocListener = (ev) => {
    if (els.eventPick?.contains(ev.target)) return;
    closeEventPickList();
  };
  queueMicrotask(() => document.addEventListener("click", eventPickDocListener, true));
}

/** 트리거: `카드ID ▾` 한 줄 (▾는 드롭다운임을 드러냄). 제목은 aria-label·목록에서 안내 */
function setEventSelection(els, eventId, titleHint = "") {
  if (!els?.eventId || !els.eventTriggerText) return;
  const id = String(eventId || "").trim();
  els.eventId.value = id;
  els.eventTriggerText.textContent = id ? `${id} ▾` : "카드 ID 선택 ▾";
  if (els.eventTrigger) {
    const hint = String(titleHint || "").trim();
    if (id) {
      els.eventTrigger.setAttribute(
        "aria-label",
        hint && hint !== id ? `카드 ID ${id}, ${hint}` : `카드 ID ${id}`
      );
    } else {
      els.eventTrigger.setAttribute("aria-label", "카드 ID 선택");
    }
  }
}

function applySelectionFromRow(els, row) {
  if (!els || !row?.dataset) return;
  const id = String(row.dataset.eventId || "").trim();
  if (!id) return;
  const title = String(row.dataset.eventTitle || "").trim();
  setEventSelection(els, id, title);
  const rowBox = String(row.dataset.eventBox || "").trim();
  const resolved = resolveBoxIdForEventId(id, { boxId: rowBox }, seatEditModalEventsCache);
  if (resolved && els.boxId) els.boxId.value = resolved;
  closeEventPickList();
  els.eventList?.querySelectorAll("li[data-event-id]").forEach((li) => {
    li.classList.toggle("is-active", li.dataset.eventId === id);
  });
}

function renderEventList(els, events, currentId) {
  if (!els?.eventList) return;
  els.eventList.innerHTML = "";
  const cur = String(currentId || "").trim();
  const ids = new Set(events.map((e) => e.id));

  if (cur && !ids.has(cur)) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = "is-muted";
    li.dataset.eventId = cur;
    li.dataset.eventTitle = cur;
    li.dataset.eventBox = "";
    li.innerHTML = `${escapeHtml(cur)}<span class="global-seat-edit-modal__opt-sub">Firestore 목록에 없는 ID (현재 Seat 값)</span>`;
    els.eventList.appendChild(li);
  }

  if (!events.length && !cur) {
    const empty = document.createElement("li");
    empty.className = "global-seat-edit-modal__select-empty is-muted";
    empty.setAttribute("role", "presentation");
    empty.textContent = "등록된 카드가 없습니다. index에서 카드를 먼저 만드세요.";
    els.eventList.appendChild(empty);
    return;
  }

  for (const ev of events) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.eventId = ev.id;
    li.dataset.eventTitle = ev.title || ev.id;
    li.dataset.eventBox = ev.boxId || "";
    const title = String(ev.title || "").trim();
    const sub = title && title !== ev.id ? escapeHtml(title) : "";
    li.innerHTML = sub
      ? `${escapeHtml(ev.id)}<span class="global-seat-edit-modal__opt-sub">${sub}</span>`
      : escapeHtml(ev.id);
    if (cur && ev.id === cur) li.classList.add("is-active");
    els.eventList.appendChild(li);
  }
}

function syncTriggerLabel(els, events, currentId) {
  const id = String(currentId || "").trim();
  if (!id) {
    setEventSelection(els, "", "");
    return;
  }
  const found = events.find((e) => e.id === id);
  setEventSelection(els, id, found ? String(found.title || "").trim() : "");
}

function closeSeatEditModal() {
  const els = getEls();
  if (!els) return;
  closeEventPickList();
  els.root.classList.remove("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("global-seat-edit-modal-open");
  currentSeatId = "";
}

export async function openSeatEditModal(seatId = "") {
  const sid = String(seatId || "").trim();
  if (!sid) return;
  const seat = getSeatById(sid);
  if (!seat) {
    alert("Seat를 찾을 수 없습니다.");
    return;
  }

  const els = getEls();
  if (
    !els ||
    !els.label ||
    !els.eventId ||
    !els.boxId ||
    !els.eventTrigger ||
    !els.eventTriggerText ||
    !els.eventList
  ) {
    console.error("globalSeatEditModal DOM missing");
    return;
  }

  currentSeatId = sid;
  const ev = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const bx = String(seat.boxId || "").trim();
  const lb = String(seat.label ?? seat.no ?? "").trim();

  els.label.value = lb;
  if (els.seatIdDisplay) els.seatIdDisplay.textContent = sid;
  /* Firestore 로드 전에도 이전 모달 값이 남지 않도록 즉시 반영 */
  setEventSelection(els, ev, "");

  let events = [];
  try {
    events = await fetchTournamentEvents();
  } catch (err) {
    console.error("fetchTournamentEvents error:", err);
    events = [];
  }

  seatEditModalEventsCache = events;
  renderEventList(els, events, ev);
  els.eventId.value = ev;
  syncTriggerLabel(els, events, ev);
  const boxFromCard = resolveBoxIdForEventId(
    ev,
    events.find((e) => String(e.id || "") === String(ev)),
    events
  );
  if (els.boxId) els.boxId.value = boxFromCard || bx;

  els.root.classList.add("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("global-seat-edit-modal-open");

  requestAnimationFrame(() => {
    els.label.focus();
    els.label.select?.();
  });
}

async function onSaveClick() {
  const els = getEls();
  if (!els || !currentSeatId) return;

  const nextLabel = String(els.label?.value || "").trim();
  const nextEventId = String(els.eventId?.value || "").trim();
  const nextBoxId = String(els.boxId?.value || "").trim();

  if (!nextLabel) {
    alert("Seat 라벨은 비울 수 없습니다.");
    return;
  }
  if (!isValidSeatLabel(nextLabel)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return;
  }
  if (!nextEventId || !nextBoxId) {
    alert("카드와 Box ID를 모두 설정해주세요.");
    return;
  }
  if (!isValidLayoutRouteIdPart(nextEventId) || !isValidLayoutRouteIdPart(nextBoxId)) {
    alert(
      "카드 ID / Box ID 형식이 올바르지 않습니다. (비어 있지 않고, / 나 __ 는 사용할 수 없습니다.)"
    );
    return;
  }
  if (looksLikeDisplayTitleNotId(nextEventId)) {
    alert("카드 ID 형식이 올바르지 않습니다. 목록에서 카드를 다시 선택해주세요.");
    return;
  }

  if (els.saveBtn) els.saveBtn.disabled = true;
  try {
    const ok = await applyGlobalSeatRename(currentSeatId, nextLabel, nextEventId, nextBoxId);
    if (ok) closeSeatEditModal();
  } catch (err) {
    console.error("applyGlobalSeatRename error:", err);
    alert("Seat 정보 변경에 실패했습니다.");
  } finally {
    if (els.saveBtn) els.saveBtn.disabled = false;
  }
}

export function initGlobalSeatEditModal() {
  const els0 = getEls();
  if (!els0) return;

  els0.root.querySelectorAll("[data-close-seat-edit]").forEach((el) => {
    el.addEventListener("click", () => closeSeatEditModal());
  });

  els0.root.querySelector(".global-seat-edit-modal__card")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  els0.saveBtn?.addEventListener("click", () => {
    void onSaveClick();
  });

  els0.eventTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    const els = getEls();
    if (!els?.eventList) return;
    if (els.eventList.hidden) openEventPickList();
    else closeEventPickList();
  });

  els0.eventList?.addEventListener("click", (e) => {
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.stopPropagation();
    const els = getEls();
    if (els) applySelectionFromRow(els, li);
  });

  els0.root.addEventListener("keydown", (e) => {
    const els = getEls();
    if (!els?.root?.classList.contains("global-seat-edit-modal--open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (els.eventList && !els.eventList.hidden) {
        closeEventPickList();
        return;
      }
      closeSeatEditModal();
    }
  });

  const inputs = [els0.label, els0.boxId].filter(Boolean);
  inputs.forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void onSaveClick();
      }
    });
  });
}
