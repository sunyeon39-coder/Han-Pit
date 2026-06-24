import { auth, db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import { openDatetimeScrollPicker } from "../shared/datetime-scroll-picker.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { formatDatetimeKorean, getNowMs } from "./dealer-attendance-format.js";
import { adjustMyWorkSession } from "./dealer-attendance-adjust-session.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import {
  computeMyTournamentWorkSummary,
  formatWorkSessionDuration
} from "./dealer-attendance-work-summary.js";

const LOG_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

/** 근무 누적은 운영 로그로 세션을 복원한다 — 본인 로그를 모달 열 때 항상 로드 */
async function loadMyAttendanceLogs(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return [];
  try {
    const snap = await getDocs(
      query(collection(db, "dealer_attendance_logs"), where("uid", "==", safeUid))
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (err) {
    console.warn("loadMyAttendanceLogs:", err?.code || err);
    return null;
  }
}

function mergeAttendanceLogs(incoming = []) {
  const byId = new Map((IX.attendanceLogs || []).map((l) => [String(l.id || ""), l]));
  for (const log of incoming) byId.set(String(log.id || ""), log);
  IX.attendanceLogs = Array.from(byId.values()).sort(
    (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
  );
}

function renderWorkSummarySessionRow(session) {
  const sessionKey = escapeHtml(String(session.sessionKey || ""));
  const startLabel = escapeHtml(formatDatetimeKorean(session.startMs));
  const endLabel = escapeHtml(formatDatetimeKorean(session.endMs));
  const durationLabel = escapeHtml(formatWorkSessionDuration(session));
  const open = session.open ? "1" : "0";

  const endControl = session.open
    ? `<span class="work-summary-session-open-label">진행 중</span>`
    : `<button
        type="button"
        class="work-summary-time-chip work-summary-time-chip--editable"
        data-session-picker="end"
        title="탭하여 종료 시각 수정"
      >
        <span class="work-summary-time-chip-label">종료</span>
        <span class="work-summary-time-chip-value">${endLabel}</span>
      </button>`;

  return `
    <li
      class="work-summary-session ${session.open ? "is-open" : ""}"
      data-session-key="${sessionKey}"
      data-prev-start="${Number(session.startMs || 0)}"
      data-prev-end="${Number(session.endMs || 0)}"
      data-open="${open}"
    >
      <div class="work-summary-session-edit">
        <button
          type="button"
          class="work-summary-time-chip work-summary-time-chip--editable"
          data-session-picker="start"
          title="탭하여 시작 시각 수정"
        >
          <span class="work-summary-time-chip-label">시작</span>
          <span class="work-summary-time-chip-value">${startLabel}</span>
        </button>
        <span class="work-summary-time-sep">~</span>
        ${endControl}
        ${session.open ? `<span class="work-summary-open-badge">근무 중</span>` : ""}
      </div>
      <span class="work-summary-session-dur">${durationLabel}</span>
    </li>
  `;
}

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
          ${summary.sessions.map((s) => renderWorkSummarySessionRow(s)).join("")}
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
    <p class="work-summary-hint">시작·종료를 탭해 스크롤로 시각을 고르고 확인을 누르면 누적에 반영됩니다.</p>
    ${sessionRows}
  `;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

async function openWorkSummaryModal() {
  refreshIndexDomRefs();
  openModal(IX.workSummaryModal);

  renderWorkSummaryModal();

  const user = auth.currentUser;
  if (!user) return;

  const logs = await withTimeout(loadMyAttendanceLogs(user.uid), 8000);
  if (Array.isArray(logs) && logs.length) {
    mergeAttendanceLogs(logs);
  }
  if (IX.workSummaryModal?.classList.contains("show")) {
    renderWorkSummaryModal();
  }
}

async function applyWorkSummarySessionTime(row, field, pickedMs) {
  if (!row || !Number.isFinite(pickedMs) || pickedMs <= 0) return;

  const user = auth.currentUser;
  if (!user) return;

  const isOpen = row.dataset.open === "1";
  const previousStartMs = Number(row.dataset.prevStart || 0);
  const previousEndMs = Number(row.dataset.prevEnd || 0);
  const newStartMs = field === "start" ? pickedMs : previousStartMs;
  const newEndMs = field === "end" ? pickedMs : previousEndMs;

  const result = await adjustMyWorkSession({
    sessionKey: row.dataset.sessionKey || "",
    previousStartMs,
    previousEndMs,
    newStartMs,
    newEndMs,
    isOpen
  });

  if (!result?.ok) return;

  if (result.attendancePatched) {
    await loadDealerAttendanceOnce();
    scheduleRenderDealerOps();
  }

  const logs = await withTimeout(loadMyAttendanceLogs(user.uid), 8000);
  if (Array.isArray(logs) && logs.length) {
    mergeAttendanceLogs(logs);
  }

  if (IX.workSummaryModal?.classList.contains("show")) {
    renderWorkSummaryModal();
  }
}

async function handleWorkSummarySessionPickerClick(e) {
  const btn = e.target.closest("[data-session-picker]");
  if (!btn) return;

  const row = btn.closest("[data-session-key]");
  if (!row) return;

  const field = String(btn.getAttribute("data-session-picker") || "").trim();
  if (field !== "start" && field !== "end") return;

  const isOpen = row.dataset.open === "1";
  const previousStartMs = Number(row.dataset.prevStart || 0);
  const previousEndMs = Number(row.dataset.prevEnd || 0);
  const initialMs = field === "start" ? previousStartMs : previousEndMs;
  const now = getNowMs();
  const minMs = now - LOG_RETENTION_MS;

  const pickedMs = await openDatetimeScrollPicker({
    initialMs,
    minMs,
    maxMs: now,
    title: field === "start" ? "시작 시각" : "종료 시각"
  });

  if (pickedMs == null) return;
  await applyWorkSummarySessionTime(row, field, pickedMs);
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
    if (e.target === IX.workSummaryModal) {
      closeWorkSummaryModal();
      return;
    }
    void handleWorkSummarySessionPickerClick(e);
  });
}

export function handleShowWorkSummaryClick() {
  openWorkSummaryModal();
}
