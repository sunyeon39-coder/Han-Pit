import { escapeHtml } from "../shared/dom-utils.js";
import { formatDateTitle } from "./time-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import {
  getStatus,
  getStatusLabel,
  groupByDate,
  formatSeatSummary
} from "./event-cards-model.js";

export function render() {
  refreshIndexDomRefs();
  if (!IX.root) return;

  IX.root.innerHTML = "";

  if (!IX.events.length) {
    IX.root.innerHTML = `
      <div class="date-header">
        <div class="date-title">No events</div>
        <div class="date-count">0 events</div>
      </div>
    `;
    return;
  }

  const groups = groupByDate(IX.events);

  groups.forEach(([date, list]) => {
    const header = document.createElement("section");
    header.className = "date-header";
    header.innerHTML = `
      <div class="date-title">${escapeHtml(formatDateTitle(date))}</div>
      <div class="date-count">${list.length} events</div>
    `;
    IX.root.appendChild(header);

    list.forEach((e) => {
      const status = getStatus(e.date, e.start, e.close);
      const seatSummaryText = formatSeatSummary(e.id, e.boxId);

      const assignedHere =
        IX.currentSeatAssignment &&
        IX.currentSeatAssignment.eventId === e.id &&
        IX.currentSeatAssignment.boxId === e.boxId;

      const assignmentBadge = assignedHere
        ? `<div class="my-seat-badge">내 배치됨 · Seat ${escapeHtml(IX.currentSeatAssignment.seatLabel || "")}</div>`
        : "";

      const card = document.createElement("div");
      card.className = `event-card ${status}`;
      card.dataset.date = e.date;
      card.dataset.start = e.start;
      card.dataset.close = e.close;
      card.dataset.eventId = e.id;
      card.dataset.boxId = e.boxId;

      card.innerHTML = `
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

      IX.root.appendChild(card);
    });
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
}
