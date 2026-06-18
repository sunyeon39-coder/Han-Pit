import { escapeHtml } from "../shared/dom-utils.js";
import { getOperationalEventDate } from "../shared/tournament-event-instance.js";
import { getNowInAppTime } from "./time-utils.js";
import { IX } from "./state.js";

export function resetEventForm() {
  if (!IX.eventCardId) return;
  IX.eventCardId.value = "";
  IX.eventCardBoxId.value = "";
  IX.eventCardDate.value = "";
  IX.eventCardTitle.value = "";
  IX.eventCardStart.value = "";
  IX.eventCardClose.value = "";
}

export function makeNextEventDefaults() {
  if (!IX.eventCardId) return;
  const nextNo = IX.events.length + 1;
  const now = getNowInAppTime();

  IX.eventCardId.value = `event_${nextNo}`;
  IX.eventCardBoxId.value = `box_${nextNo}`;
  IX.eventCardDate.value = getOperationalEventDate(now);
  IX.eventCardTitle.value = `Event ${nextNo}`;
  IX.eventCardStart.value = "21:00";
  IX.eventCardClose.value = "21:30";
}

export function syncSelectedEventForm() {
  if (!IX.eventCardSelect || !IX.eventCardId) return;

  const selected = IX.events.find((e) => e.id === IX.eventCardSelect.value);

  if (!selected) {
    resetEventForm();
    return;
  }

  IX.eventCardId.value = selected.cardId || selected.id || "";
  IX.eventCardBoxId.value = selected.boxId || "";
  IX.eventCardDate.value = selected.date || "";
  IX.eventCardTitle.value = selected.title || "";
  IX.eventCardStart.value = selected.start || "";
  IX.eventCardClose.value = selected.close || "";
}

export function populateEventSelect(preferredId = "") {
  if (!IX.eventCardSelect) return;

  if (!IX.events.length) {
    IX.eventCardSelect.innerHTML = `<option value="">카드 없음</option>`;
    resetEventForm();
    return;
  }

  IX.eventCardSelect.innerHTML = IX.events
    .map(
      (e) => `
    <option value="${escapeHtml(e.id)}">${escapeHtml(e.title)} · ${escapeHtml(e.date)} ${escapeHtml(e.start)} · ${escapeHtml(e.cardId || e.id)}/${escapeHtml(e.boxId)}</option>
  `
    )
    .join("");

  const targetId =
    preferredId && IX.events.some((e) => e.id === preferredId) ? preferredId : IX.events[0].id;

  IX.eventCardSelect.value = targetId;
  syncSelectedEventForm();
}

export function renderEventAdminList() {
  if (!IX.eventCardList) return;

  if (!IX.events.length) {
    IX.eventCardList.innerHTML = `<div class="empty-list">카드가 없습니다.</div>`;
    return;
  }

  IX.eventCardList.innerHTML = IX.events
    .map(
      (e) => `
    <div class="event-admin-row" data-id="${escapeHtml(e.id)}">
      <div class="event-admin-main">
        <div class="event-admin-name">${escapeHtml(e.title)}</div>
        <div class="event-admin-meta">
          ${escapeHtml(e.date)} · ${escapeHtml(e.start)} ~ ${escapeHtml(e.close)} · 카드 ${escapeHtml(e.cardId || e.id)} · ${escapeHtml(e.boxId)}
        </div>
      </div>
      <button class="event-admin-pick" type="button" data-pick-id="${escapeHtml(e.id)}">지정</button>
    </div>
  `
    )
    .join("");
}
