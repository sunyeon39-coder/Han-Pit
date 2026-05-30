import { auth } from "../firebase.js";

import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import {
  computeMyTournamentWorkSummary,
  formatWorkSessionRange
} from "./dealer-attendance-work-summary.js";

function renderWorkSummaryModal() {
  refreshIndexDomRefs();
  const body = IX.workSummaryBody;
  if (!body) return;

  const user = auth.currentUser;
  if (!user) {
    body.innerHTML = `<p class="work-summary-empty">로그인이 필요합니다.</p>`;
    return;
  }

  const derived = getDerivedAttendance(user);
  const summary = computeMyTournamentWorkSummary(user, IX.attendanceLogs, derived);

  const sessionRows =
    summary.sessions.length === 0
      ? `<p class="work-summary-empty">이 대회에서 집계된 근무 기록이 없습니다.</p>`
      : `<ul class="work-summary-sessions">
          ${summary.sessions
            .map(
              (s) => `
            <li class="work-summary-session ${s.open ? "is-open" : ""}">
              ${escapeHtml(formatWorkSessionRange(s))}
              ${s.open ? `<span class="work-summary-open-badge">근무 중</span>` : ""}
            </li>`
            )
            .join("")}
        </ul>`;

  body.innerHTML = `
    <div class="work-summary-metrics">
      <div class="work-summary-metric">
        <span class="work-summary-metric-label">근무 일수</span>
        <strong class="work-summary-metric-value">${escapeHtml(summary.dayLabel)}</strong>
      </div>
      <div class="work-summary-metric">
        <span class="work-summary-metric-label">총 근무 시간</span>
        <strong class="work-summary-metric-value">${escapeHtml(summary.durationLabel)}</strong>
      </div>
    </div>
    <p class="work-summary-hint">출근·퇴근 기록과 현재 근무 중인 시간을 합산합니다. 휴식 시간은 현재 세션에서 반영됩니다.</p>
    ${sessionRows}
  `;
}

function openWorkSummaryModal() {
  renderWorkSummaryModal();
  openModal(IX.workSummaryModal);
}

function closeWorkSummaryModal() {
  closeModal(IX.workSummaryModal);
}

export function setupWorkSummaryEvents() {
  refreshIndexDomRefs();
  if (IX.workSummaryEventsBound) return;
  if (!IX.workSummaryModal) return;

  IX.workSummaryEventsBound = true;

  IX.closeWorkSummaryBtn?.addEventListener("click", closeWorkSummaryModal);
  IX.workSummaryModal?.addEventListener("click", (e) => {
    if (e.target === IX.workSummaryModal) closeWorkSummaryModal();
  });
}

export function handleShowWorkSummaryClick() {
  openWorkSummaryModal();
}
