import { escapeHtml } from "./utils.js";
import { fetchTournamentEvents } from "./tournament-events.js";
import { resolveBoxIdForEventId } from "./event-box-resolve.js";
import { writePersistedSeatAddForm } from "./seat-add-form-persist.js";

let docListener = null;

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
  const ids = new Set(events.map((e) => e.id));

  if (cur && !ids.has(cur)) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = "is-muted";
    li.dataset.eventId = cur;
    li.dataset.eventTitle = cur;
    li.dataset.eventBox = "";
    li.innerHTML = `${escapeHtml(cur)}<span class="global-seat-edit-modal__opt-sub">목록에 없는 ID (현재 값)</span>`;
    listEl.appendChild(li);
  }

  if (!events.length && !cur) {
    const empty = document.createElement("li");
    empty.className = "global-seat-edit-modal__select-empty is-muted";
    empty.setAttribute("role", "presentation");
    empty.textContent = "등록된 카드가 없습니다.";
    listEl.appendChild(empty);
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

/** 패널이 다시 그려진 뒤 호출: Seat 추가 줄의 카드 ID를 드롭다운으로 연결 */
export async function wireSeatAddEventPicker() {
  detachDocListener();
  const pick = document.getElementById("seatAddEventPick");
  const hidden = document.getElementById("seatEventInput");
  const trigger = document.getElementById("seatAddEventTrigger");
  const text = document.getElementById("seatAddEventTriggerText");
  const list = document.getElementById("seatAddEventList");
  const boxInput = document.getElementById("seatBoxInput");
  if (!pick || !hidden || !trigger || !text || !list) return;

  let events = [];
  try {
    events = await fetchTournamentEvents();
  } catch (err) {
    console.error("wireSeatAddEventPicker fetch error:", err);
  }

  const currentId = String(hidden.value || "").trim();
  buildList(list, events, currentId);
  syncSeatAddEventPickerFromHidden();
  applySeatAddBoxForEvent(events, currentId, boxInput);
  persistSeatAddRow(hidden, boxInput);

  const applyRow = (li) => {
    const id = String(li?.dataset?.eventId || "").trim();
    if (!id) return;
    hidden.value = id;
    text.textContent = `${id} ▾`;
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

  list.addEventListener("click", (e) => {
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.stopPropagation();
    applyRow(li);
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
  text.textContent = id ? `${id} ▾` : "카드 ID 선택 ▾";
  setTriggerAria(trigger, id, "");
  persistSeatAddRow(hidden, boxInput);
}
