import { escapeHtml } from "../shared/dom-utils.js";
import { formatDateTitle, getNowInAppTime, parseDateTime } from "./time-utils.js";
import { getTournamentId } from "./core-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { readIndexEventsTodayCache } from "./index-events-session-cache.js";
import {
  getStatus,
  getStatusLabel,
  groupByDate,
  formatSeatSummary
} from "./event-cards-model.js";

function eventCardKey(eventId, boxId) {
  return `${String(eventId || "").trim()}::${String(boxId || "").trim()}`;
}

/** 날짜 묶음은 그다음 날 아침 6시(앱 기준 시각)가 지나면 목록 맨 아래로 — 다음 날짜가 위로 올라온다.
 *  (CLOSED 는 등록 마감일 뿐 그날 일정이 끝난 게 아니라 기준으로 쓰지 않는다.)
 *  날짜 안의 카드 순서는 그대로(시작 시각 순). */
const DAY_ROLLOVER_TIME = "06:00";

function isDateGroupDone(date) {
  const at = parseDateTime(date, DAY_ROLLOVER_TIME);
  if (!at) return false;
  return getNowInAppTime() >= new Date(at.getTime() + 24 * 60 * 60 * 1000);
}

function orderGroupsDoneLast(groups) {
  const done = groups.filter(([date]) => isDateGroupDone(date));
  const active = groups.filter(([date]) => !isDateGroupDone(date));
  return [...active, ...done];
}

/** 지금 맨 아래로 내려가 있어야 할 날짜들 — 바뀌면(아침 6시를 넘기면) 다시 render */
let renderedDoneKey = "";
function currentDoneKey() {
  const dates = [...new Set(IX.events.map((e) => e.date))];
  return dates.filter(isDateGroupDone).join(",");
}

function buildEventCardInnerHtml(e, status) {
  const seatSummaryText = formatSeatSummary(e.id, e.boxId);
  const assignedHere =
    IX.currentSeatAssignment &&
    IX.currentSeatAssignment.eventId === e.id &&
    IX.currentSeatAssignment.boxId === e.boxId;
  const assignmentBadge = assignedHere
    ? `<div class="my-seat-badge">내 배치됨 · Seat ${escapeHtml(IX.currentSeatAssignment.seatLabel || "")}</div>`
    : "";

  return `
        <div class="event-header">
          <div>
            <div class="event-title">${escapeHtml(e.title)}</div>
            ${assignmentBadge}
          </div>
          <span class="pill ${status}">${escapeHtml(getStatusLabel(status))}</span>
        </div>

        <div class="event-info">
          <div class="info-box">
            <div class="info-label">Time</div>
            ${escapeHtml(e.start)}
          </div>

          <div class="info-box">
            <div class="info-label">Reg Closes</div>
            ${escapeHtml(e.close)}
          </div>

          <div class="info-box">
            <div class="info-label">Table</div>
            <div class="entries-table">${escapeHtml(seatSummaryText)}</div>
          </div>
        </div>
      `;
}

/** 좌석 요약·배지만 갱신 (global_seats 스냅샷용, 전체 카드 재생성 없음) */
export function patchEventCardsLight() {
  refreshIndexDomRefs();
  if (!IX.root) return false;
  const cards = IX.root.querySelectorAll(".event-card[data-event-key]");
  if (!cards.length) return false;

  cards.forEach((card) => {
    const [eventId, boxId] = String(card.dataset.eventKey || "").split("::");
    const e = IX.events.find((ev) => ev.id === eventId && ev.boxId === boxId);
    if (!e) return;
    const status = getStatus(e.date, e.start, e.close);
    card.className = `event-card ${status}`;
    card.dataset.date = e.date;
    card.dataset.start = e.start;
    card.dataset.close = e.close;
    card.innerHTML = buildEventCardInnerHtml(e, status);
  });
  // 아침 6시를 넘겨 날짜 순서가 바뀌어야 하면 전체 render 로 넘긴다
  return currentDoneKey() === renderedDoneKey;
}

function restoreEventsForRender() {
  if (IX.events.length) return true;
  const tid = getTournamentId();
  if (!tid) return false;
  const cached = readIndexEventsTodayCache(tid);
  if (!cached?.length) return false;
  IX.events = cached;
  return true;
}

export function render() {
  refreshIndexDomRefs();
  if (!IX.root) return;

  restoreEventsForRender();

  if (!IX.events.length) {
    IX.root.innerHTML = `
      <div class="date-header">
        <div class="date-title">No events</div>
        <div class="date-count">0 events</div>
      </div>
    `;
    return;
  }

  const groups = orderGroupsDoneLast(groupByDate(IX.events));
  renderedDoneKey = currentDoneKey();
  const desiredKeys = new Set();
  const existingByKey = new Map();
  IX.root.querySelectorAll(".event-card[data-event-key]").forEach((card) => {
    existingByKey.set(String(card.dataset.eventKey || ""), card);
  });

  const frag = document.createDocumentFragment();

  groups.forEach(([date, list]) => {
    const header = document.createElement("section");
    header.className = "date-header";
    header.dataset.dateGroup = date;
    header.innerHTML = `
      <div class="date-title">${escapeHtml(formatDateTitle(date))}</div>
      <div class="date-count">${list.length} events</div>
    `;
    frag.appendChild(header);

    list.forEach((e) => {
      const key = eventCardKey(e.id, e.boxId);
      desiredKeys.add(key);
      const status = getStatus(e.date, e.start, e.close);

      let card = existingByKey.get(key);
      if (!card) {
        card = document.createElement("div");
        existingByKey.set(key, card);
      }
      card.className = `event-card ${status}`;
      card.dataset.date = e.date;
      card.dataset.start = e.start;
      card.dataset.close = e.close;
      card.dataset.eventId = e.id;
      card.dataset.boxId = e.boxId;
      card.dataset.eventKey = key;
      card.innerHTML = buildEventCardInnerHtml(e, status);
      frag.appendChild(card);
    });
  });

  IX.root.querySelectorAll(".date-header, .event-card").forEach((el) => el.remove());
  IX.root.appendChild(frag);

  existingByKey.forEach((card, key) => {
    if (!desiredKeys.has(key)) card.remove();
  });
}

export function refreshCardStatuses() {
  document.querySelectorAll(".event-card").forEach((card) => {
    const status = getStatus(
      card.dataset.date,
      card.dataset.start,
      card.dataset.close
    );

    card.classList.remove("scheduled", "opened", "running", "closed");
    card.classList.add(status);

    const pill = card.querySelector(".pill");
    if (pill) {
      pill.className = `pill ${status}`;
      pill.textContent = getStatusLabel(status);
    }
  });
  // 아침 6시를 넘겨 내려가야 할 날짜가 생기면 순서를 다시 맞춘다
  if (IX.events.length && currentDoneKey() !== renderedDoneKey) render();
}
