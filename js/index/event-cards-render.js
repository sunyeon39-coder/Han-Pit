import { escapeHtml } from "../shared/dom-utils.js";
import { formatDateTitle } from "./time-utils.js";
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

/** 그날 이벤트가 전부 종료(CLOSED)되면 그 날짜 묶음을 목록 맨 아래로 — 다음 날짜가 위로 올라온다.
 *  날짜 안의 카드 순서는 그대로(시작 시각 순). */
function orderGroupsClosedLast(groups) {
  const isClosed = (e) => getStatus(e.date, e.start, e.close) === "closed";
  const done = groups.filter(([, list]) => list.every(isClosed));
  const active = groups.filter(([, list]) => !list.every(isClosed));
  return [...active, ...done];
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

  let closedChanged = false;
  cards.forEach((card) => {
    const [eventId, boxId] = String(card.dataset.eventKey || "").split("::");
    const e = IX.events.find((ev) => ev.id === eventId && ev.boxId === boxId);
    if (!e) return;
    const status = getStatus(e.date, e.start, e.close);
    if ((status === "closed") !== card.classList.contains("closed")) closedChanged = true;
    card.className = `event-card ${status}`;
    card.dataset.date = e.date;
    card.dataset.start = e.start;
    card.dataset.close = e.close;
    card.innerHTML = buildEventCardInnerHtml(e, status);
  });
  // 종료 여부가 바뀌면 순서가 달라지므로 전체 render 로 넘긴다
  return !closedChanged;
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

  const groups = orderGroupsClosedLast(groupByDate(IX.events));
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
  let closedChanged = false;
  document.querySelectorAll(".event-card").forEach((card) => {
    const status = getStatus(
      card.dataset.date,
      card.dataset.start,
      card.dataset.close
    );
    if ((status === "closed") !== card.classList.contains("closed")) closedChanged = true;

    card.classList.remove("scheduled", "opened", "running", "closed");
    card.classList.add(status);

    const pill = card.querySelector(".pill");
    if (pill) {
      pill.className = `pill ${status}`;
      pill.textContent = getStatusLabel(status);
    }
  });
  // 방금 종료된(또는 시간이 바뀌어 다시 열린) 이벤트가 있으면 순서를 다시 맞춘다
  if (closedChanged) render();
}
