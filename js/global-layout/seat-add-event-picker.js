import { escapeHtml } from "./utils.js";
import {
  getEventCardIdFromRecord,
  parseEventInstanceDocId
} from "../shared/tournament-event-instance.js";
import { fetchEventCardsForSeatEdit } from "./tournament-events.js";
import { resolveBoxIdForEventId } from "./event-box-resolve.js";
import { writePersistedSeatAddForm } from "./seat-add-form-persist.js";
import { GL } from "./state.js";

let docListener = null;
let seatAddEventsCache = [];
let seatAddEventsTournamentId = "";
let seatAddEventsFetchInflight = null;

export function getSeatAddEventsCache() {
  return seatAddEventsCache;
}

export function invalidateSeatAddEventsCache() {
  seatAddEventsCache = [];
  seatAddEventsTournamentId = "";
  seatAddEventsFetchInflight = null;
}

async function loadSeatAddEvents() {
  const tid = String(GL.tournamentId || "").trim();
  if (!tid) return [];
  if (tid === seatAddEventsTournamentId && seatAddEventsCache.length) {
    return seatAddEventsCache;
  }
  if (seatAddEventsFetchInflight) return seatAddEventsFetchInflight;

  seatAddEventsFetchInflight = fetchEventCardsForSeatEdit()
    .then((events) => {
      seatAddEventsCache = events;
      seatAddEventsTournamentId = tid;
      return events;
    })
    .finally(() => {
      seatAddEventsFetchInflight = null;
    });
  return seatAddEventsFetchInflight;
}

function eventCardDisplayId(event = {}, fallbackId = "") {
  const display = getEventCardIdFromRecord(event);
  if (display) return display;
  return String(fallbackId || event?.id || "").trim();
}

function formatSeatAddTriggerLabel(eventId = "") {
  const id = String(eventId || "").trim();
  if (!id) return "카드 선택 ▾";
  const found = seatAddEventsCache.find((e) => String(e.id || "") === id);
  const parsed = parseEventInstanceDocId(id);
  const label = found
    ? eventCardDisplayId(found, id)
    : parsed?.cardId || getEventCardIdFromRecord({ id }) || id;
  return `${label} ▾`;
}

function detachDocListener() {
  if (docListener) {
    document.removeEventListener("click", docListener, true);
    docListener = null;
  }
}

function closeList(pick, trigger, list) {
  if (list) list.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  detachDocListener();
}

function openList(pick, trigger, list) {
  if (!list || !trigger) return;
  list.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  detachDocListener();
  docListener = (ev) => {
    if (pick?.contains(ev.target)) return;
    closeList(pick, trigger, list);
  };
  queueMicrotask(() => document.addEventListener("click", docListener, true));
}

function buildList(listEl, events, currentId) {
  if (!listEl) return;
  listEl.innerHTML = "";
  const cur = String(currentId || "").trim();

  if (!events.length && !cur) {
    const empty = document.createElement("li");
    empty.className = "global-seat-edit-modal__select-empty is-muted";
    empty.setAttribute("role", "presentation");
    empty.textContent = "—";
    listEl.appendChild(empty);
    return;
  }

  for (const ev of events) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.eventId = ev.id;
    li.dataset.eventTitle = ev.title || ev.id;
    li.dataset.eventBox = ev.boxId || "";
    li.innerHTML = escapeHtml(eventCardDisplayId(ev, ev.id));
    if (cur && ev.id === cur) li.classList.add("is-active");
    listEl.appendChild(li);
  }
}

function applySeatAddBoxForEvent(events, eventId, boxInput, rowHint = null) {
  if (!boxInput) return;
  const id = String(eventId || "").trim();
  if (!id) return;
  const resolved = resolveBoxIdForEventId(id, rowHint, events);
  if (resolved) boxInput.value = resolved;
}

function persistSeatAddRow(hidden, boxInput) {
  const id = String(hidden?.value || "").trim();
  if (!id) return;
  const bx = String(boxInput?.value || "").trim();
  writePersistedSeatAddForm(id, bx);
}

function setTriggerAria(trigger, id, titleHint) {
  if (!trigger) return;
  const v = String(id || "").trim();
  const hint = String(titleHint || "").trim();
  if (v) {
    trigger.setAttribute("aria-label", hint && hint !== v ? `카드 ID ${v}, ${hint}` : `카드 ID ${v}`);
  } else {
    trigger.setAttribute("aria-label", "카드 ID 선택");
  }
}

/** 패널 최초 구성 시 1회만 리스너 연결; 이후는 목록·라벨만 갱신 */
export async function wireSeatAddEventPicker() {
  const pick = document.getElementById("seatAddEventPick");
  const hidden = document.getElementById("seatEventInput");
  const trigger = document.getElementById("seatAddEventTrigger");
  const text = document.getElementById("seatAddEventTriggerText");
  const list = document.getElementById("seatAddEventList");
  const boxInput = document.getElementById("seatBoxInput");
  if (!pick || !hidden || !trigger || !text || !list) return;

  let events = [];
  try {
    events = await loadSeatAddEvents();
  } catch (err) {
    const code = String(err?.code || "").trim();
    if (code === "already-exists") {
      console.warn("wireSeatAddEventPicker: fetch skipped (listener target conflict)");
      events = seatAddEventsCache;
    } else {
      console.error("wireSeatAddEventPicker fetch error:", err);
    }
  }
  seatAddEventsCache = events;

  const currentId = String(hidden.value || "").trim();
  buildList(list, events, currentId);
  syncSeatAddEventPickerFromHidden();
  applySeatAddBoxForEvent(events, currentId, boxInput);
  persistSeatAddRow(hidden, boxInput);

  if (pick.dataset.seatAddWired === "1") return;
  pick.dataset.seatAddWired = "1";

  detachDocListener();

  const applyRow = (li) => {
    const id = String(li?.dataset?.eventId || "").trim();
    if (!id) return;
    hidden.value = id;
    text.textContent = formatSeatAddTriggerLabel(id);
    setTriggerAria(trigger, id, String(li.dataset.eventTitle || "").trim());
    applySeatAddBoxForEvent(events, id, boxInput, {
      boxId: String(li.dataset.eventBox || "").trim()
    });
    persistSeatAddRow(hidden, boxInput);
    list.querySelectorAll("li[data-event-id]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.eventId === id);
    });
    closeList(pick, trigger, list);
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (list.hidden) openList(pick, trigger, list);
    else closeList(pick, trigger, list);
  });

  list.addEventListener("mousedown", (e) => {
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.preventDefault();
    e.stopPropagation();
    applyRow(li);
  });

  list.addEventListener("click", (e) => {
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.stopPropagation();
  });

  boxInput?.addEventListener("input", () => persistSeatAddRow(hidden, boxInput));
}

/** hidden #seatEventInput 값에 맞춰 트리거 문구만 동기화 (addGlobalSeat 저장 직후 등) */
export function syncSeatAddEventPickerFromHidden() {
  const hidden = document.getElementById("seatEventInput");
  const trigger = document.getElementById("seatAddEventTrigger");
  const text = document.getElementById("seatAddEventTriggerText");
  const boxInput = document.getElementById("seatBoxInput");
  if (!hidden || !text) return;
  const id = String(hidden.value || "").trim();
  const found = seatAddEventsCache.find((e) => String(e.id || "") === id);
  text.textContent = formatSeatAddTriggerLabel(id);
  setTriggerAria(trigger, id, found ? String(found.title || "").trim() : "");
  persistSeatAddRow(hidden, boxInput);
}
