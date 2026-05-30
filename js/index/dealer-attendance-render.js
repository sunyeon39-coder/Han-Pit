import { auth } from "../firebase.js";

import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { getTournamentId } from "./core-utils.js";
import { escapeHtml } from "../shared/dom-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import {
  getAttendanceStatusLabel,
  formatClockOrDash,
  formatDuration,
  msToDatetimeLocalValue
} from "./dealer-attendance-format.js";
import { getDerivedAttendance, getWorkingMs } from "./dealer-attendance-derived.js";
import {
  getAdminAttendanceList,
  getFilteredAdminAttendanceList
} from "./dealer-attendance-admin-list.js";

export function renderDealerOps() {
  refreshIndexDomRefs();
  if (!IX.dealerOpsMount) {
    console.warn("renderDealerOps: dealerOpsMount not found");
    return;
  }

  const user = auth.currentUser;
  const tid = getTournamentId();
  const t = IX.currentTournament;
  const tournamentMeta = t ? { id: t.id, name: t.name, logoText: t.logoText } : null;
  const isAdmin = canShowTournamentOpsUi(
    user?.email,
    IX.currentUserProfile,
    tid,
    tournamentMeta,
    user?.uid
  );
  const me = user ? getDerivedAttendance(user) : null;

  const myStatus = me?.status || "off";
  const canCheckIn = myStatus === "off" || myStatus === "checked_out";
  const canCheckOut = myStatus === "waiting";

  const myCheckInText = formatClockOrDash(me?.checkedInAt);
  const myCheckOutText = formatClockOrDash(me?.checkedOutAt);
  const canEditCheckIn = Boolean(me?.checkedInAt) && myStatus !== "off";
  const canEditCheckOut = Boolean(me?.checkedOutAt) && myStatus === "checked_out";

  let adminHtml = "";

  if (isAdmin) {
    const list = getFilteredAdminAttendanceList();
    const totalList = getAdminAttendanceList();

    const counts = {
      waiting: 0,
      assigned: 0,
      checked_out: 0
    };

    totalList.forEach((item) => {
      const s = item.status || "off";
      if (counts[s] !== undefined) counts[s] += 1;
    });

    if (isAdmin && IX.dealerUiCollapsed) {
      IX.dealerOpsMount.innerHTML = `
    <section class="dealer-admin-card">
      <div class="dealer-ops-head">
        <div>
          <div class="dealer-ops-title">딜러 운영 현황</div>
          <div class="dealer-ops-sub">현재 대회 기준 실시간 출근 / 대기 / 배치 상태</div>
        </div>
        <button class="dealer-toggle-btn" data-dealer-toggle>▲</button>
      </div>
    </section>
  `;
      return;
    }

    adminHtml = `
      <section class="dealer-admin-card">
        <div class="dealer-ops-head">
  <div>
    <div class="dealer-ops-title">딜러 운영 현황</div>
    <div class="dealer-ops-sub">현재 대회 기준 실시간 출근 / 대기 / 배치 상태</div>
  </div>

  <button class="dealer-toggle-btn" data-dealer-toggle>
  ${IX.dealerUiCollapsed ? "▼" : "▲"}
</button>
</div>

        <div class="dealer-admin-summary">
          <div class="dealer-metric">
            <div class="dealer-metric-label">대기</div>
            <div class="dealer-metric-value">${counts.waiting}</div>
          </div>
          <div class="dealer-metric">
            <div class="dealer-metric-label">배치중</div>
            <div class="dealer-metric-value">${counts.assigned}</div>
          </div>
          <div class="dealer-metric">
            <div class="dealer-metric-label">퇴근</div>
            <div class="dealer-metric-value">${counts.checked_out}</div>
          </div>
        </div>
        <div class="dealer-admin-toolbar">
  <input
    class="dealer-admin-search"
    type="text"
    placeholder="-"
    value="${escapeHtml(IX.dealerAdminUi.search)}"
    data-dealer-search
  />

  <select class="dealer-admin-filter" data-dealer-filter>
    <option value="all" ${IX.dealerAdminUi.status === "all" ? "selected" : ""}>전체</option>
    <option value="waiting" ${IX.dealerAdminUi.status === "waiting" ? "selected" : ""}>대기</option>
    <option value="assigned" ${IX.dealerAdminUi.status === "assigned" ? "selected" : ""}>배치중</option>
    <option value="checked_out" ${IX.dealerAdminUi.status === "checked_out" ? "selected" : ""}>퇴근</option>
  </select>

  <select class="dealer-admin-sort" data-dealer-sort>
    <option value="name" ${IX.dealerAdminUi.sort === "name" ? "selected" : ""}>이름순</option>
    <option value="status" ${IX.dealerAdminUi.sort === "status" ? "selected" : ""}>상태순</option>
    <option value="recent" ${IX.dealerAdminUi.sort === "recent" ? "selected" : ""}>최근 변경순</option>
  </select>
</div>

        <div class="dealer-admin-list">
          ${
            list.length
              ? list.map((item) => `
                <div class="dealer-row">
  <div class="dealer-row-main">
    <div class="dealer-row-name">${escapeHtml(item.nickname || item.email || item.uid || "Unknown")}</div>
    <div class="dealer-row-meta">${escapeHtml(item.email || "-")}</div>
  </div>

  <div class="dealer-row-status">
    <span class="dealer-status-pill ${escapeHtml(item.status || "off")}">
      ${escapeHtml(getAttendanceStatusLabel(item.status || "off"))}
    </span>
  </div>

  <div class="dealer-row-center">
    <span>${item.currentSeatLabel ? `Seat ${escapeHtml(item.currentSeatLabel)}` : "-"}</span>
    <span>${escapeHtml(formatDuration(getWorkingMs(item)))}</span>
  </div>

  <div class="dealer-row-actions">
    <button class="dealer-mini-btn" data-admin-action="checked_out" data-admin-uid="${escapeHtml(item.uid)}">퇴근</button>
  </div>
</div>
              `).join("")
              : `<div class="dealer-empty">아직 출근 기록이 없습니다.</div>`
          }
        </div>
      </section>
    `;
  }

  const selfHtml = !isAdmin ? `
  <section class="dealer-self-card">
    <div class="dealer-ops-head">
      <div>
        <div class="dealer-ops-title">내 근무 상태</div>
        <div class="dealer-ops-sub">현재 대회 기준 출근 / 퇴근 관리</div>
      </div>
      <span class="dealer-status-pill ${escapeHtml(myStatus)}">
        ${escapeHtml(getAttendanceStatusLabel(myStatus))}
      </span>
    </div>

    <div class="dealer-self-compact">
      <div class="dealer-self-times">
        ${
          canEditCheckIn
            ? `<label class="dealer-time-chip dealer-time-chip--editable" title="탭하여 출근 시각 수정">
                <span class="dealer-time-chip-label">출근</span>
                <input
                  type="datetime-local"
                  class="dealer-time-chip-input"
                  data-edit-check-in
                  value="${escapeHtml(msToDatetimeLocalValue(me.checkedInAt))}"
                  step="60"
                  aria-label="출근 시각 수정"
                />
                <span class="dealer-time-chip-caret" aria-hidden="true"></span>
              </label>`
            : `<div class="dealer-time-chip">
                <span class="dealer-time-chip-label">출근</span>
                <span class="dealer-time-chip-value">${escapeHtml(myCheckInText)}</span>
              </div>`
        }

        ${
          canEditCheckOut
            ? `<label class="dealer-time-chip dealer-time-chip--editable" title="탭하여 퇴근 시각 수정">
                <span class="dealer-time-chip-label">퇴근</span>
                <input
                  type="datetime-local"
                  class="dealer-time-chip-input"
                  data-edit-check-out
                  value="${escapeHtml(msToDatetimeLocalValue(me.checkedOutAt))}"
                  step="60"
                  aria-label="퇴근 시각 수정"
                />
                <span class="dealer-time-chip-caret" aria-hidden="true"></span>
              </label>`
            : `<div class="dealer-time-chip">
                <span class="dealer-time-chip-label">퇴근</span>
                <span class="dealer-time-chip-value">${escapeHtml(myCheckOutText)}</span>
              </div>`
        }
      </div>

      <div class="dealer-action-row">
        <button class="dealer-action-btn primary" data-self-action="waiting" ${canCheckIn ? "" : "disabled"}>출근하기</button>
        <button class="dealer-action-btn danger" data-self-action="checked_out" ${canCheckOut ? "" : "disabled"}>퇴근하기</button>
        <button class="dealer-action-btn ghost" type="button" data-show-work-summary>근무 합계</button>
      </div>
    </div>
  </section>
` : "";

  IX.dealerOpsMount.innerHTML = `
    ${selfHtml}
    ${adminHtml}
  `;
}

/** 같은 프레임에서 여러 번 호출돼도 `renderDealerOps`는 한 번만 돌도록 묶습니다. */
export function scheduleRenderDealerOps() {
  if (IX.dealerOpsRenderTimer != null) return;
  IX.dealerOpsRenderTimer = requestAnimationFrame(() => {
    IX.dealerOpsRenderTimer = null;
    renderDealerOps();
  });
}
