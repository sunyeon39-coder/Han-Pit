import { GL } from "./state.js";
import { getSeatById } from "./utils.js";
import { applyGlobalSeatRename } from "./firestore-ops.js";
import { isValidSeatLabel, isValidLayoutRouteIdPart, looksLikeDisplayTitleNotId, escapeHtml } from "./utils.js";
import {
  getEventCardIdFromRecord,
  parseEventInstanceDocId
} from "../shared/tournament-event-instance.js";
import {
  fetchEventCardsForSeatEdit,
  resolveEventIdForSave
} from "./tournament-events.js";
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

function eventCardDisplayId(event = {}, fallbackId = "") {
  const display = getEventCardIdFromRecord(event);
  if (display) return display;
  return String(fallbackId || event?.id || "").trim();
}

/** 트리거: 카드 ID만 표시. 긴 제목은 aria-label 보조 */
function setEventSelection(els, eventId, titleHint = "") {
  if (!els?.eventId || !els.eventTriggerText) return;
  const id = String(eventId || "").trim();
  els.eventId.value = id;
  const found = seatEditModalEventsCache.find((ev) => String(ev.id || "").trim() === id);
  const parsed = parseEventInstanceDocId(id);
  const label = found
    ? eventCardDisplayId(found, id)
    : parsed?.cardId || getEventCardIdFromRecord({ id }) || id;
  els.eventTriggerText.textContent = id ? `${label} ▾` : "카드 선택 ▾";
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

  if (!events.length && !cur) {
    const empty = document.createElement("li");
    empty.className = "global-seat-edit-modal__select-empty is-muted";
    empty.setAttribute("role", "presentation");
    empty.textContent = "—";
    els.eventList.appendChild(empty);
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
  if (els.boxId) els.boxId.value = bx;
  if (els.seatIdDisplay) els.seatIdDisplay.textContent = sid;
  setEventSelection(els, ev, "");

  els.root.classList.add("global-seat-edit-modal--open");
  els.root.setAttribute("aria-hidden", "false");
  document.body.classList.add("global-seat-edit-modal-open");
  renderEventList(els, [], ev);
  if (els.eventTriggerText && !ev) {
    els.eventTriggerText.textContent = "카드 선택";
  }

  requestAnimationFrame(() => {
    els.label.focus();
    els.label.select?.();
  });

  void (async () => {
    let events = [];
    try {
      events = await fetchEventCardsForSeatEdit();
    } catch (err) {
      console.error("fetchTournamentEvents error:", err);
      events = [];
    }

    seatEditModalEventsCache = events;
    const resolvedEv = resolveEventIdForSave(ev, events);
    renderEventList(els, events, resolvedEv || ev);
    els.eventId.value = resolvedEv || ev;
    syncTriggerLabel(els, events, resolvedEv || ev);
    // 카드(eventId)가 열었을 때와 그대로면 이 Seat가 실제로 있는 Box(bx)를 최우선으로 쓴다.
    // resolveBoxIdForEventId는 "그 카드의 기본/대표 Box"를 돌려주는데, 한 카드에 Box가
    // 여러 개(1, 2, 99...)인 경우 이 값이 지금 편집 중인 Seat의 실제 Box와 다를 수 있다.
    // 예전에는 이 기본값이 무조건 덮어써서, 모달만 열었다가 그대로 저장해도 Seat가
    // 엉뚱한 Box로 조용히 이동(사실상 사라짐)하는 사고가 났다. 카드를 실제로 바꿨을 때는
    // (resolvedEv가 원래 ev와 다름) 새 카드의 기본 Box를 쓰는 게 맞다.
    const eventChanged = String(resolvedEv || ev || "").trim() !== String(ev || "").trim();
    if (els.boxId) {
      if (!eventChanged && bx) {
        els.boxId.value = bx;
      } else {
        const boxFromCard = resolveBoxIdForEventId(
          resolvedEv || ev,
          events.find((e) => String(e.id || "") === String(resolvedEv || ev)),
          events
        );
        els.boxId.value = boxFromCard || bx;
      }
    }
  })();
}

async function onSaveClick() {
  const els = getEls();
  if (!els) return;
  // 모달이 열려 있는데 상태가 비었으면 표시된 Seat ID로 복구(리스너/상태 유실 방어)
  if (!currentSeatId) {
    const shownId = String(els.seatIdDisplay?.textContent || "").trim();
    if (shownId) currentSeatId = shownId;
  }
  if (!currentSeatId) {
    alert("Seat 정보를 찾지 못했습니다. 모달을 닫고 다시 열어 주세요.");
    return;
  }

  const nextLabel = String(els.label?.value || "").trim();
  const nextEventId = resolveEventIdForSave(els.eventId?.value, seatEditModalEventsCache);
  const nextBoxId = String(els.boxId?.value || "").trim();
  if (els.eventId && nextEventId) els.eventId.value = nextEventId;

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
  const knownCard = seatEditModalEventsCache.some(
    (ev) => String(ev?.id || "").trim() === nextEventId
  );
  if (!knownCard && looksLikeDisplayTitleNotId(nextEventId)) {
    alert("카드는 목록에서 선택해 주세요. (index「카드 관리」에 등록된 카드만 사용 가능)");
    return;
  }

  if (els.saveBtn) els.saveBtn.disabled = true;
  try {
    const savedSeatId = currentSeatId;
    const result = await applyGlobalSeatRename(savedSeatId, nextLabel, nextEventId, nextBoxId);
    if (result?.ok) {
      closeSeatEditModal();
      const nav = result.shouldOfferLayout;
      if (nav?.eventId && nav?.boxId) {
        requestAnimationFrame(() => {
          const layoutUrl = `./layout.html?tournamentId=${encodeURIComponent(
            GL.tournamentId || ""
          )}&eventId=${encodeURIComponent(nav.eventId)}&boxId=${encodeURIComponent(nav.boxId)}&focusSeatId=${encodeURIComponent(savedSeatId)}`;
          if (
            window.confirm(
              "변경된 카드·Box의 배치 화면(layout.html)으로 이동할까요?\n(취소하면 통합 배치도에 그대로 있으며, 나중에 직접 열어도 됩니다.)"
            )
          ) {
            sessionStorage.setItem("eventId", nav.eventId);
            sessionStorage.setItem("boxId", nav.boxId);
            location.href = layoutUrl;
          }
        });
      }
    } else {
      alert("저장되지 않았습니다. 카드·Box·라벨을 확인한 뒤 다시 시도해 주세요.");
    }
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
  if (els0.root.dataset.bound === "1") return;
  els0.root.dataset.bound = "1";

  // 저장/취소/카드선택은 모달 루트에 위임해 노드 재생성·중복 초기화에도 항상 동작하게 한다.
  els0.root.addEventListener("click", (e) => {
    if (e.target.closest("#globalSeatEditSave")) {
      e.preventDefault();
      e.stopPropagation();
      void onSaveClick();
      return;
    }
    if (e.target.closest("[data-close-seat-edit]")) {
      closeSeatEditModal();
      return;
    }
    if (e.target.closest("#globalSeatEditEventTrigger")) {
      e.stopPropagation();
      const els = getEls();
      if (!els?.eventList) return;
      if (els.eventList.hidden) openEventPickList();
      else closeEventPickList();
      return;
    }
    const li = e.target.closest("li[data-event-id]");
    if (li && els0.eventList?.contains(li)) {
      e.preventDefault();
      e.stopPropagation();
      const els = getEls();
      if (els) applySelectionFromRow(els, li);
    }
  });

  els0.eventList?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const li = e.target?.closest?.("li[data-event-id]");
    if (!li) return;
    e.preventDefault();
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
