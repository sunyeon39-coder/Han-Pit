import { GL } from "./state.js";
import { getDefaultEventBoxForNewSeat } from "./panel-ui.js";
import { addGlobalSeatFromValues } from "./firestore-ops.js";
import {
  getEventCardIdFromRecord,
  parseEventInstanceDocId
} from "../shared/tournament-event-instance.js";
import { fetchEventCardsForSeatEdit } from "./tournament-events.js";
import { resolveBoxIdForEventId } from "./event-box-resolve.js";
import {
  readPersistedSeatAddForm,
  writePersistedSeatAddForm
} from "./seat-add-form-persist.js";
import {
  escapeHtml,
  isValidLayoutRouteIdPart,
  isValidSeatLabel,
  looksLikeDisplayTitleNotId
} from "./utils.js";

let eventsCache = [];
let docListener = null;
let wired = false;

function getEls() {
  const root = document.getElementById("globalMobileSeatAddModal");
  if (!root) return null;
  return {
    root,
    label: document.getElementById("globalMobileSeatAddLabel"),
    eventId: document.getElementById("globalMobileSeatAddEventId"),
    eventPick: document.getElementById("globalMobileSeatAddEventPick"),
    eventTrigger: document.getElementById("globalMobileSeatAddEventTrigger"),
    eventTriggerText: document.getElementById("globalMobileSeatAddEventTriggerText"),
    eventList: document.getElementById("globalMobileSeatAddEventList"),
    boxId: document.getElementById("globalMobileSeatAddBoxId"),
    submitBtn: document.getElementById("globalMobileSeatAddSubmit")
  };
}

function detachDocListener() {
  if (docListener) {
    document.removeEventListener("click", docListener, true);
    docListener = null;
  }
}

function closeEventPickList() {
  const els = getEls();
  if (!els?.eventList || !els.eventTrigger) return;
  els.eventList.hidden = true;
  els.eventTrigger.setAttribute("aria-expanded", "false");
  detachDocListener();
}

function openEventPickList() {
  const els = getEls();
  if (!els?.eventList || !els.eventTrigger) return;
  els.eventList.hidden = false;
  els.eventTrigger.setAttribute("aria-expanded", "true");
  detachDocListener();
  docListener = (ev) => {
    if (els.eventPick?.contains(ev.target)) return;
    closeEventPickList();
  };
  queueMicrotask(() => document.addEventListener("click", docListener, true));
}

function eventCardDisplayId(event = {}, fallbackId = "") {
  const display = getEventCardIdFromRecord(event);
  if (display) return display;
  return String(fallbackId || event?.id || "").trim();
}

function setEventSelection(els, eventId, titleHint = "") {
  if (!els?.eventId || !els.eventTriggerText) return;
  const id = String(eventId || "").trim();
  els.eventId.value = id;
  const found = eventsCache.find((ev) => String(ev.id || "").trim() === id);
  const parsed = parseEventInstanceDocId(id);
  const label = found
    ? eventCardDisplayId(found, id)
    : parsed?.cardId || getEventCardIdFromRecord({ id }) || id;
  els.eventTriggerText.textContent = id ? `${label} ▾` : "카드 선택 ▾";
  if (els.eventTrigger) {
    const hint = String(titleHint || "").trim();
    els.eventTrigger.setAttribute(
      "aria-label",
      hint && hint !== id ? `카드 ID ${id}, ${hint}` : id ? `카드 ID ${id}` : "카드 ID 선택"
    );
  }
}

function renderEventList(els, events, currentId) {
  if (!els?.eventList) return;
  els.eventList.innerHTML = "";
  const cur = String(currentId || "").trim();

  if (!events.length && !cur) {
    const empty = document.createElement("li");
    empty.className = "global-seat-edit-modal__select-empty is-muted";
    empty.setAttribute("role", "presentation");
    empty.textContent =
      "운영일(06:00~익일 05:59)에 해당하는 카드가 없습니다. index에서 오늘 날짜 카드를 만드세요.";
    els.eventList.appendChild(empty);
    return;
  }

  for (const ev of events) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.eventId = ev.id;
    li.dataset.eventTitle = ev.title || ev.id;
    li.dataset.eventBox = ev.boxId || "";
    const card = eventCardDisplayId(ev, ev.id);
    const sub = String(ev.id || "").trim();
    li.innerHTML = `${escapeHtml(card)}<span class="global-seat-edit-modal__opt-sub">${escapeHtml(sub)}</span>`;
    if (cur && ev.id === cur) li.classList.add("is-active");
    els.eventList.appendChild(li);
  }
}

function applySelectionFromRow(els, row) {
  if (!els || !row?.dataset) return;
  const id = String(row.dataset.eventId || "").trim();
  if (!id) return;
  setEventSelection(els, id, String(row.dataset.eventTitle || "").trim());
  const rowBox = String(row.dataset.eventBox || "").trim();
  const resolved = resolveBoxIdForEventId(id, { boxId: rowBox }, eventsCache);
  if (resolved && els.boxId) els.boxId.value = resolved;
  writePersistedSeatAddForm(id, els.boxId?.value || "");
  closeEventPickList();
  els.eventList?.querySelectorAll("li[data-event-id]").forEach((li) => {
    li.classList.toggle("is-active", li.dataset.eventId === id);
  });
}

function closeModal() {
  const els = getEls();
  if (!els?.root) return;
  els.root.classList.remove("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("global-seat-edit-modal-open");
  closeEventPickList();
}

function resolveInitialEventBox() {
  const stored = readPersistedSeatAddForm();
  const base = getDefaultEventBoxForNewSeat();
  if (stored?.eventId) {
    return {
      eventId: stored.eventId,
      boxId: stored.boxId || base.boxId || ""
    };
  }
  return base;
}

async function onSubmit() {
  const els = getEls();
  if (!els) return;

  const label = String(els.label?.value || "").trim();
  const eventId = String(els.eventId?.value || "").trim();
  const boxId = String(els.boxId?.value || "").trim();

  if (!label) {
    alert("Seat 라벨을 입력하세요.");
    els.label?.focus();
    return;
  }
  if (!isValidSeatLabel(label)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return;
  }
  if (!eventId || !boxId) {
    alert("카드 ID와 Box ID를 모두 선택·입력해 주세요.");
    return;
  }
  if (!isValidLayoutRouteIdPart(eventId) || !isValidLayoutRouteIdPart(boxId)) {
    alert("카드 ID / Box ID 형식이 올바르지 않습니다.");
    return;
  }
  const knownCard = eventsCache.some((ev) => String(ev?.id || "").trim() === eventId);
  if (!knownCard && looksLikeDisplayTitleNotId(eventId)) {
    alert("카드는 목록에서 선택해 주세요. (index「카드 관리」에 등록된 카드만 사용 가능)");
    return;
  }

  if (els.submitBtn) els.submitBtn.disabled = true;
  try {
    writePersistedSeatAddForm(eventId, boxId);
    await addGlobalSeatFromValues({ label, eventId, boxId });
    closeModal();
  } catch (err) {
    console.error("addGlobalSeatFromValues error:", err);
    if (String(err?.code || "").includes("permission-denied")) {
      alert("좌석 생성 권한이 없습니다.");
    } else {
      alert("Seat 추가에 실패했습니다.");
    }
  } finally {
    if (els.submitBtn) els.submitBtn.disabled = false;
  }
}

export async function openGlobalMobileSeatAddModal() {
  const els = getEls();
  if (!els) {
    alert("Seat 추가 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    return;
  }

  GL.mobileSheet?.classList.remove("open");

  let events = [];
  try {
    events = await fetchEventCardsForSeatEdit();
  } catch (err) {
    console.error("openGlobalMobileSeatAddModal fetch:", err);
  }
  eventsCache = events;

  const { eventId, boxId } = resolveInitialEventBox();
  if (els.label) els.label.value = "";
  if (els.eventId) els.eventId.value = eventId;
  if (els.boxId) els.boxId.value = boxId;
  setEventSelection(els, eventId);
  const resolvedBox = resolveBoxIdForEventId(eventId, { boxId }, eventsCache);
  if (resolvedBox && els.boxId) els.boxId.value = resolvedBox;

  renderEventList(els, events, eventId);

  els.root.classList.add("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("global-seat-edit-modal-open");
  els.label?.focus();
}

export function initGlobalMobileSeatAddModal() {
  const els = getEls();
  if (!els || wired) return;
  wired = true;

  els.root.querySelectorAll("[data-close-mobile-seat-add]").forEach((el) => {
    el.addEventListener("click", () => closeModal());
  });

  els.root.querySelector(".global-seat-edit-modal__card")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  els.submitBtn?.addEventListener("click", () => {
    void onSubmit();
  });

  els.eventTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    const el = getEls();
    if (!el?.eventList) return;
    if (el.eventList.hidden) openEventPickList();
    else closeEventPickList();
  });

  els.eventList?.addEventListener("click", (e) => {
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.stopPropagation();
    applySelectionFromRow(getEls(), li);
  });

  els.boxId?.addEventListener("input", () => {
    const el = getEls();
    const id = String(el?.eventId?.value || "").trim();
    if (id) writePersistedSeatAddForm(id, el?.boxId?.value || "");
  });
}
