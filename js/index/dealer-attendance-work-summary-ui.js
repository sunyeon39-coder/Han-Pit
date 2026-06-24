import { auth, db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import {
  datetimeLocalValueToMs,
  msToDatetimeLocalValue
} from "./dealer-attendance-format.js";
import { adjustMyWorkSession } from "./dealer-attendance-adjust-session.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import {
  computeMyTournamentWorkSummary,
  formatWorkSessionDuration
} from "./dealer-attendance-work-summary.js";

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
    return [];
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
  const startValue = escapeHtml(msToDatetimeLocalValue(session.startMs));
  const endValue = escapeHtml(msToDatetimeLocalValue(session.endMs));
  const durationLabel = escapeHtml(formatWorkSessionDuration(session));
  const open = session.open ? "1" : "0";

  const endControl = session.open
    ? `<span class="work-summary-session-open-label">진행 중</span>`
    : `<label class="work-summary-time-chip work-summary-time-chip--editable" title="탭하여 종료 시각 수정">
        <span class="work-summary-time-chip-label">종료</span>
        <input
          type="datetime-local"
          class="work-summary-time-chip-input"
          data-session-end
          value="${endValue}"
        />
      </label>`;

  return `
    <li
      class="work-summary-session ${session.open ? "is-open" : ""}"
      data-session-key="${sessionKey}"
      data-prev-start="${Number(session.startMs || 0)}"
      data-prev-end="${Number(session.endMs || 0)}"
      data-open="${open}"
    >
      <div class="work-summary-session-edit">
        <label class="work-summary-time-chip work-summary-time-chip--editable" title="탭하여 시작 시각 수정">
          <span class="work-summary-time-chip-label">시작</span>
          <input
            type="datetime-local"
            class="work-summary-time-chip-input"
            data-session-start
            value="${startValue}"
          />
        </label>
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
    <p class="work-summary-hint">각 근무 구간의 시작·종료 시각을 탭해 수정할 수 있습니다. 변경 내용은 누적 시간에 반영됩니다.</p>
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

  // 먼저 현재 가진 데이터로 즉시 렌더(로딩에서 멈추지 않도록).
  renderWorkSummaryModal();

  const user = auth.currentUser;
  if (!user) return;

  // 로그는 백그라운드로 불러오고, 응답이 멈춰도 8초 후 현재 화면을 유지한다.
  const logs = await withTimeout(loadMyAttendanceLogs(user.uid), 8000);
  if (Array.isArray(logs) && logs.length) {
    mergeAttendanceLogs(logs);
  }
  if (IX.workSummaryModal?.classList.contains("show")) {
    renderWorkSummaryModal();
  }
}

async function handleWorkSummarySessionChange(e) {
  const input = e.target.closest("[data-session-start],[data-session-end]");
  if (!input) return;

  const row = input.closest("[data-session-key]");
  if (!row) return;

  const user = auth.currentUser;
  if (!user) return;

  const startInput = row.querySelector("[data-session-start]");
  const endInput = row.querySelector("[data-session-end]");
  const isOpen = row.dataset.open === "1";
  const previousStartMs = Number(row.dataset.prevStart || 0);
  const previousEndMs = Number(row.dataset.prevEnd || 0);
  const newStartMs = datetimeLocalValueToMs(startInput?.value);
  const newEndMs = isOpen ? previousEndMs : datetimeLocalValueToMs(endInput?.value);

  const ok = await adjustMyWorkSession({
    sessionKey: row.dataset.sessionKey || "",
    previousStartMs,
    previousEndMs,
    newStartMs,
    newEndMs,
    isOpen
  });

  if (ok) {
    await loadDealerAttendanceOnce();
    scheduleRenderDealerOps();
    const logs = await withTimeout(loadMyAttendanceLogs(user.uid), 8000);
    if (Array.isArray(logs) && logs.length) {
      mergeAttendanceLogs(logs);
    }
    if (IX.workSummaryModal?.classList.contains("show")) {
      renderWorkSummaryModal();
    }
    return;
  }

  if (startInput) startInput.value = msToDatetimeLocalValue(previousStartMs);
  if (endInput) endInput.value = msToDatetimeLocalValue(previousEndMs);
}

function handleWorkSummaryTimeChipClick(e) {
  const chip = e.target.closest(".work-summary-time-chip--editable");
  if (!chip || e.target.closest(".work-summary-time-chip-input")) return;
  const input = chip.querySelector("[data-session-start],[data-session-end]");
  if (!input) return;
  input.focus();
  try {
    if (typeof input.showPicker === "function") input.showPicker();
  } catch (_) {
    /* iOS 구버전: focus만으로 네이티브 피커 */
  }
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
    handleWorkSummaryTimeChipClick(e);
  });
  IX.workSummaryModal?.addEventListener("change", (e) => {
    void handleWorkSummarySessionChange(e);
  });
}

export function handleShowWorkSummaryClick() {
  openWorkSummaryModal();
}
