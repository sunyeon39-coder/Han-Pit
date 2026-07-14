import { auth, db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import { openDatetimeScrollPicker } from "../shared/datetime-scroll-picker.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { getTournamentId } from "./core-utils.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { getAdminAttendanceList } from "./dealer-attendance-admin-list.js";
import { formatDatetimeKorean, getNowMs } from "./dealer-attendance-format.js";
import { adjustMyWorkSession, adjustUserWorkSession } from "./dealer-attendance-adjust-session.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import {
  computeMyTournamentWorkSummary,
  formatWorkSessionDuration
} from "./dealer-attendance-work-summary.js";
import {
  defaultPayProfile,
  loadPayProfile,
  savePayProfile
} from "./dealer-pay-profile.js";
import { buildPayBreakdown, wonLabel } from "./dealer-attendance-pay-calc.js";

const LOG_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

let workSummaryPayProfile = null;
let workSummaryPayLoadState = "idle";
let workSummaryPaySaveState = "idle";

function getWorkSummaryContext() {
  const user = auth.currentUser;
  const target = IX.workSummaryTarget;
  if (target?.uid) {
    return {
      uid: String(target.uid).trim(),
      nickname: String(target.nickname || "").trim(),
      isAdminTarget: true
    };
  }
  if (!user) return null;
  return {
    uid: user.uid,
    nickname: String(IX.currentUserProfile?.nickname || user.displayName || "").trim(),
    isAdminTarget: false
  };
}

function getDerivedForWorkSummary(ctx) {
  if (!ctx?.uid) return null;
  if (ctx.isAdminTarget) {
    return (
      getAdminAttendanceList().find((item) => String(item.uid || "").trim() === ctx.uid) || {
        uid: ctx.uid,
        status: "off"
      }
    );
  }
  const user = auth.currentUser;
  return user ? getDerivedAttendance(user) : null;
}

function logsForWorkSummaryUid(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return [];
  return (IX.attendanceLogs || []).filter((log) => String(log.uid || "").trim() === safeUid);
}

/** 근무 누적은 운영 로그로 세션을 복원한다 — 모달 열 때 대상 로그를 로드 */
async function loadAttendanceLogsForUid(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return [];
  try {
    const snap = await getDocs(
      query(collection(db, "dealer_attendance_logs"), where("uid", "==", safeUid))
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (err) {
    console.warn("loadAttendanceLogsForUid:", err?.code || err);
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

function canEditWorkSummaryPay() {
  const user = auth.currentUser;
  return canShowTournamentOpsUi(
    user?.email,
    IX.currentUserProfile,
    getTournamentId(),
    IX.currentTournament
      ? {
          id: IX.currentTournament.id,
          name: IX.currentTournament.name,
          logoText: IX.currentTournament.logoText
        }
      : null,
    user?.uid
  );
}

function resetWorkSummaryPayState() {
  workSummaryPayProfile = null;
  workSummaryPayLoadState = "idle";
  workSummaryPaySaveState = "idle";
}

function readPayProfileFromDom(body, uid = "") {
  const paySection = body?.querySelector("[data-work-summary-pay]");
  if (!paySection) return workSummaryPayProfile || defaultPayProfile(uid);

  const payMode =
    paySection.querySelector('[name="workSummaryPayMode"]:checked')?.value === "daily"
      ? "daily"
      : "hourly";
  const hourlyRate = Math.max(
    0,
    Number(paySection.querySelector("[data-pay-hourly]")?.value || 0) || 0
  );
  const dailyRate = Math.max(
    0,
    Number(paySection.querySelector("[data-pay-daily]")?.value || 0) || 0
  );
  const extras = [...paySection.querySelectorAll("[data-pay-extra-row]")]
    .map((row) => ({
      label: String(row.querySelector("[data-extra-label]")?.value || "").trim(),
      amount: Math.max(0, Number(row.querySelector("[data-extra-amount]")?.value || 0) || 0)
    }))
    .filter((item) => item.label || item.amount > 0);

  return {
    uid: String(uid || workSummaryPayProfile?.uid || "").trim(),
    payMode,
    hourlyRate,
    dailyRate,
    extras
  };
}

function renderPayBreakdownHtml(breakdown, profile = {}) {
  const dayRows =
    breakdown.days.length > 0
      ? breakdown.days
          .map(
            (day) => `
        <tr>
          <td>${escapeHtml(day.label)}</td>
          <td>${escapeHtml(wonLabel(day.pay))}</td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="2" class="work-summary-pay-breakdown-empty">정산 근무일 없음</td></tr>`;

  const extras = Array.isArray(profile.extras) ? profile.extras : [];
  const extrasRows = extras
    .filter((item) => item.label || item.amount > 0)
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.label || "부가")}</td>
        <td>${escapeHtml(wonLabel(item.amount))}</td>
      </tr>`
    )
    .join("");

  return `
    <table class="work-summary-pay-breakdown-table">
      <thead>
        <tr>
          <th>정산일</th>
          <th>근무비</th>
        </tr>
      </thead>
      <tbody>${dayRows}</tbody>
    </table>
    ${
      extrasRows
        ? `
      <table class="work-summary-pay-breakdown-table">
        <thead>
          <tr>
            <th>부가비용</th>
            <th>금액</th>
          </tr>
        </thead>
        <tbody>${extrasRows}</tbody>
      </table>`
        : ""
    }
    <div class="work-summary-pay-totals">
      ${
        breakdown.withholdingTotal > 0
          ? `
      <div class="work-summary-pay-total-row">
        <span>근무비 TOTAL (세전)</span>
        <strong>${escapeHtml(wonLabel(breakdown.grossWorkTotal))}</strong>
      </div>
      <div class="work-summary-pay-total-row is-deduction">
        <span>원천징수 3.3%</span>
        <strong>-${escapeHtml(wonLabel(breakdown.withholdingTotal))}</strong>
      </div>`
          : ""
      }
      <div class="work-summary-pay-total-row">
        <span>근무비 TOTAL</span>
        <strong>${escapeHtml(wonLabel(breakdown.workTotal))}</strong>
      </div>
      ${
        breakdown.extrasTotal > 0
          ? `
      <div class="work-summary-pay-total-row">
        <span>부가비용</span>
        <strong>${escapeHtml(wonLabel(breakdown.extrasTotal))}</strong>
      </div>`
          : ""
      }
      <div class="work-summary-pay-total-row is-grand">
        <span>최종지급액</span>
        <strong>${escapeHtml(wonLabel(breakdown.grandTotal))}</strong>
      </div>
    </div>
  `;
}

function renderPayExtraRow(extra = {}, canEdit = false) {
  const label = escapeHtml(String(extra.label || ""));
  const amount = Math.max(0, Number(extra.amount || 0) || 0);
  if (!canEdit) {
    return `
      <li class="work-summary-pay-extra-row is-readonly">
        <span>${label || "부가"}</span>
        <strong>${escapeHtml(wonLabel(amount))}</strong>
      </li>`;
  }

  return `
    <li class="work-summary-pay-extra-row" data-pay-extra-row>
      <input type="text" data-extra-label placeholder="항목명" value="${label}" />
      <input type="number" data-extra-amount min="0" step="1000" placeholder="금액" value="${amount || ""}" />
      <button type="button" class="mini-btn" data-extra-remove>삭제</button>
    </li>`;
}

function renderWorkSummaryPaySection(profile, breakdown, canEdit) {
  if (workSummaryPayLoadState === "loading") {
    return `
      <section class="work-summary-pay">
        <p class="work-summary-pay-loading">인건비 설정 불러오는 중…</p>
      </section>`;
  }

  const payMode = profile?.payMode === "daily" ? "daily" : "hourly";
  const hourlyRate = Math.max(0, Number(profile?.hourlyRate || 0) || 0);
  const dailyRate = Math.max(0, Number(profile?.dailyRate || 0) || 0);
  const extras = Array.isArray(profile?.extras) ? profile.extras : [];
  const saveLabel =
    workSummaryPaySaveState === "saving"
      ? "저장 중…"
      : workSummaryPaySaveState === "saved"
        ? "저장됨"
        : "저장";

  const settingsHtml = canEdit
    ? `
      <div class="work-summary-pay-mode">
        <label class="work-summary-pay-mode-option">
          <input type="radio" name="workSummaryPayMode" value="hourly" ${payMode === "hourly" ? "checked" : ""} />
          시급
        </label>
        <label class="work-summary-pay-mode-option">
          <input type="radio" name="workSummaryPayMode" value="daily" ${payMode === "daily" ? "checked" : ""} />
          일급
        </label>
      </div>
      <div class="work-summary-pay-rates">
        <label class="work-summary-pay-rate ${payMode === "hourly" ? "is-active" : ""}">
          <span>시급(원)</span>
          <input type="number" data-pay-hourly min="0" step="1000" value="${hourlyRate || ""}" />
        </label>
        <label class="work-summary-pay-rate ${payMode === "daily" ? "is-active" : ""}">
          <span>일급(원)</span>
          <input type="number" data-pay-daily min="0" step="1000" value="${dailyRate || ""}" />
        </label>
      </div>
      <div class="work-summary-pay-extras">
        <div class="work-summary-pay-extras-head">
          <span>부가비용</span>
          <button type="button" class="mini-btn" data-pay-extra-add>+ 추가</button>
        </div>
        <ul class="work-summary-pay-extras-list" data-pay-extras-list>
          ${extras.map((item) => renderPayExtraRow(item, true)).join("")}
        </ul>
      </div>`
    : `
      <div class="work-summary-pay-readonly">
        <p class="work-summary-pay-readonly-line">
          <span>정산 방식</span>
          <strong>${payMode === "daily" ? "일급" : "시급"}</strong>
        </p>
        <p class="work-summary-pay-readonly-line">
          <span>${payMode === "daily" ? "일급" : "시급"}</span>
          <strong>${escapeHtml(wonLabel(payMode === "daily" ? dailyRate : hourlyRate))}</strong>
        </p>
        ${
          extras.length
            ? `
        <ul class="work-summary-pay-extras-list is-readonly">
          ${extras.map((item) => renderPayExtraRow(item, false)).join("")}
        </ul>`
            : ""
        }
      </div>`;

  return `
    <section class="work-summary-pay" data-work-summary-pay>
      <div class="work-summary-pay-head">
        <h3>인건비</h3>
        ${
          canEdit
            ? `<button type="button" class="mini-btn primary" data-pay-save ${workSummaryPaySaveState === "saving" ? "disabled" : ""}>${escapeHtml(saveLabel)}</button>`
            : ""
        }
      </div>
      ${settingsHtml}
      <div class="work-summary-pay-breakdown" data-pay-breakdown>
        ${renderPayBreakdownHtml(breakdown, profile)}
      </div>
    </section>`;
}

function updateWorkSummaryPayBreakdown(body, sessions = []) {
  if (!body) return;
  const ctx = getWorkSummaryContext();
  const profile = readPayProfileFromDom(body, ctx?.uid);
  const breakdown = buildPayBreakdown(sessions, profile);
  const breakdownEl = body.querySelector("[data-pay-breakdown]");
  if (breakdownEl) {
    breakdownEl.innerHTML = renderPayBreakdownHtml(breakdown, profile);
  }

  const payMode = profile.payMode === "daily" ? "daily" : "hourly";
  body.querySelectorAll(".work-summary-pay-rate").forEach((el) => {
    const isHourlyRate = Boolean(el.querySelector("[data-pay-hourly]"));
    el.classList.toggle("is-active", payMode === "hourly" ? isHourlyRate : !isHourlyRate);
  });
}

function syncWorkSummaryModalTitle(ctx) {
  const titleEl = document.getElementById("workSummaryModalTitle");
  if (!titleEl) return;
  if (ctx?.isAdminTarget) {
    const name = ctx.nickname || "직원";
    titleEl.textContent = `${name}님 근무 합계`;
    return;
  }
  titleEl.textContent = "대회 근무 합계";
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

  const ctx = getWorkSummaryContext();
  if (!ctx) {
    body.innerHTML = `<p class="work-summary-empty">로그인이 필요합니다.</p>`;
    return;
  }

  syncWorkSummaryModalTitle(ctx);

  const derived = getDerivedForWorkSummary(ctx);
  const logs = logsForWorkSummaryUid(ctx.uid);
  const summary = computeMyTournamentWorkSummary({ uid: ctx.uid }, logs, derived);

  const sessionRows =
    summary.sessions.length === 0
      ? `<p class="work-summary-empty">이 대회에서 집계된 근무 기록이 없습니다.</p>`
      : `<ul class="work-summary-sessions">
          ${summary.sessions.map((s) => renderWorkSummarySessionRow(s)).join("")}
        </ul>`;

  const canEditPay = canEditWorkSummaryPay();
  const payProfile = workSummaryPayProfile || defaultPayProfile(ctx.uid);
  const payBreakdown = buildPayBreakdown(summary.sessions, payProfile);
  const paySection =
    workSummaryPayLoadState === "idle"
      ? ""
      : renderWorkSummaryPaySection(payProfile, payBreakdown, canEditPay);

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
    ${paySection}
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
  resetWorkSummaryPayState();
  openModal(IX.workSummaryModal);

  const ctx = getWorkSummaryContext();
  if (ctx?.uid) {
    workSummaryPayLoadState = "loading";
  }

  renderWorkSummaryModal();

  if (!ctx?.uid) return;

  const [logs, profile] = await Promise.all([
    withTimeout(loadAttendanceLogsForUid(ctx.uid), 8000),
    loadPayProfile(ctx.uid)
  ]);

  if (Array.isArray(logs) && logs.length) {
    mergeAttendanceLogs(logs);
  }

  workSummaryPayProfile = profile || defaultPayProfile(ctx.uid);
  workSummaryPayLoadState = "ready";

  if (IX.workSummaryModal?.classList.contains("show")) {
    renderWorkSummaryModal();
  }
}

async function applyWorkSummarySessionTime(row, field, pickedMs) {
  if (!row || !Number.isFinite(pickedMs) || pickedMs <= 0) return;

  const ctx = getWorkSummaryContext();
  if (!ctx?.uid) return;

  const isOpen = row.dataset.open === "1";
  const previousStartMs = Number(row.dataset.prevStart || 0);
  const previousEndMs = Number(row.dataset.prevEnd || 0);
  const newStartMs = field === "start" ? pickedMs : previousStartMs;
  const newEndMs = field === "end" ? pickedMs : previousEndMs;

  const sessionArgs = {
    sessionKey: row.dataset.sessionKey || "",
    previousStartMs,
    previousEndMs,
    newStartMs,
    newEndMs,
    isOpen
  };

  const result = ctx.isAdminTarget
    ? await adjustUserWorkSession({
        targetUid: ctx.uid,
        targetNickname: ctx.nickname,
        ...sessionArgs
      })
    : await adjustMyWorkSession(sessionArgs);

  if (!result?.ok) return;

  if (result.attendancePatched) {
    await loadDealerAttendanceOnce();
    scheduleRenderDealerOps();
  }

  const logs = await withTimeout(loadAttendanceLogsForUid(ctx.uid), 8000);
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
  IX.workSummaryTarget = null;
  resetWorkSummaryPayState();
  closeModal(IX.workSummaryModal);
}

function getWorkSummarySessionsForPay() {
  const ctx = getWorkSummaryContext();
  if (!ctx?.uid) return [];
  const derived = getDerivedForWorkSummary(ctx);
  const logs = logsForWorkSummaryUid(ctx.uid);
  return computeMyTournamentWorkSummary({ uid: ctx.uid }, logs, derived).sessions;
}

async function handleWorkSummaryPaySave() {
  const ctx = getWorkSummaryContext();
  const body = IX.workSummaryBody;
  if (!ctx?.uid || !body || !canEditWorkSummaryPay()) return;

  const profile = readPayProfileFromDom(body, ctx.uid);
  workSummaryPaySaveState = "saving";
  renderWorkSummaryModal();

  try {
    const ok = await savePayProfile(ctx.uid, profile);
    if (!ok) throw new Error("save failed");
    workSummaryPayProfile = profile;
    workSummaryPaySaveState = "saved";
  } catch (err) {
    console.warn("handleWorkSummaryPaySave:", err?.code || err);
    workSummaryPaySaveState = "idle";
    alert("인건비 저장에 실패했습니다.");
  }

  if (IX.workSummaryModal?.classList.contains("show")) {
    renderWorkSummaryModal();
    if (workSummaryPaySaveState === "saved") {
      setTimeout(() => {
        if (IX.workSummaryModal?.classList.contains("show") && workSummaryPaySaveState === "saved") {
          workSummaryPaySaveState = "idle";
          renderWorkSummaryModal();
        }
      }, 1200);
    }
  }
}

function handleWorkSummaryPayExtraAdd() {
  const body = IX.workSummaryBody;
  if (!body || !canEditWorkSummaryPay()) return;

  const list = body.querySelector("[data-pay-extras-list]");
  if (!list) return;

  list.querySelector(".work-summary-pay-extras-empty")?.remove();
  list.insertAdjacentHTML("beforeend", renderPayExtraRow({}, true));
  updateWorkSummaryPayBreakdown(body, getWorkSummarySessionsForPay());
}

function handleWorkSummaryPayExtraRemove(btn) {
  const body = IX.workSummaryBody;
  const row = btn?.closest("[data-pay-extra-row]");
  if (!body || !row) return;

  row.remove();

  updateWorkSummaryPayBreakdown(body, getWorkSummarySessionsForPay());
}

function handleWorkSummaryPayInput(e) {
  const body = IX.workSummaryBody;
  if (!body || !canEditWorkSummaryPay()) return;

  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  if (
    target.matches("[data-pay-hourly], [data-pay-daily], [data-extra-label], [data-extra-amount]") ||
    target.matches('[name="workSummaryPayMode"]')
  ) {
    updateWorkSummaryPayBreakdown(body, getWorkSummarySessionsForPay());
  }
}

async function handleWorkSummaryModalClick(e) {
  if (e.target === IX.workSummaryModal) {
    closeWorkSummaryModal();
    return;
  }

  const saveBtn = e.target.closest("[data-pay-save]");
  if (saveBtn) {
    void handleWorkSummaryPaySave();
    return;
  }

  const addBtn = e.target.closest("[data-pay-extra-add]");
  if (addBtn) {
    handleWorkSummaryPayExtraAdd();
    return;
  }

  const removeBtn = e.target.closest("[data-extra-remove]");
  if (removeBtn) {
    handleWorkSummaryPayExtraRemove(removeBtn);
    return;
  }

  void handleWorkSummarySessionPickerClick(e);
}

export function setupWorkSummaryEvents() {
  refreshIndexDomRefs();
  if (IX.workSummaryEventsBound) return;
  if (!IX.workSummaryModal) return;

  IX.workSummaryEventsBound = true;

  IX.closeWorkSummaryBtn?.addEventListener("click", closeWorkSummaryModal);
  IX.workSummaryModal?.addEventListener("click", (e) => {
    void handleWorkSummaryModalClick(e);
  });
  IX.workSummaryModal?.addEventListener("input", handleWorkSummaryPayInput);
  IX.workSummaryModal?.addEventListener("change", handleWorkSummaryPayInput);
}

export function handleShowWorkSummaryClick() {
  IX.workSummaryTarget = null;
  void openWorkSummaryModal();
}

export async function openAdminWorkSummaryModal(uid, nickname = "") {
  IX.workSummaryTarget = {
    uid: String(uid || "").trim(),
    nickname: String(nickname || "").trim()
  };
  await openWorkSummaryModal();
}
