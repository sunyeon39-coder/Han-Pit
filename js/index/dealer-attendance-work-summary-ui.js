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
  computeMyTournamentWorkSummary,
  formatWorkSessionRange
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
