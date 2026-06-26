import { auth } from "../firebase.js";

import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import {
  countTournamentWaitingDisplay,
  countTournamentOccupiedFromGlobalSeats,
  buildIndexAttendanceInactiveUids,
  buildIndexAttendanceWaitingRows
} from "../shared/tournament-waiting-queue.js";
import { getTournamentId } from "./core-utils.js";
import { escapeHtml } from "../shared/dom-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import {
  getAttendanceStatusLabel,
  formatClockOrDash,
  formatDuration,
  formatDatetimeKorean
} from "./dealer-attendance-format.js";
import { getDerivedAttendance, getWorkingMs } from "./dealer-attendance-derived.js";
import { syncIndexOpsToolbar } from "./index-ops-chrome.js";
import { bootstrapIndexDealerOps } from "./index-ops-bootstrap.js";
import {
  getAdminAttendanceList,
  getFilteredAdminAttendanceList
} from "./dealer-attendance-admin-list.js";

function syncDealerAdminUiFromDom() {
  const root = IX.dealerOpsMount;
  if (!root) return;

  const searchEl = root.querySelector("[data-dealer-search]");
  if (searchEl) IX.dealerAdminUi.search = String(searchEl.value || "");

  const filterEl = root.querySelector("[data-dealer-filter]");
  if (filterEl) IX.dealerAdminUi.status = String(filterEl.value || "all");

  const sortEl = root.querySelector("[data-dealer-sort]");
  if (sortEl) IX.dealerAdminUi.sort = String(sortEl.value || "name");
}

function getDealerAdminCounts() {
  const counts = {
    waiting: 0,
    assigned: 0,
    checked_out: 0,
    off: 0
  };

  const tournamentId = getTournamentId();
  const inactive = buildIndexAttendanceInactiveUids(
    IX.dealerAttendanceMap,
    tournamentId,
    IX.globalWaiting
  );

  getAdminAttendanceList().forEach((item) => {
    const s = item.status || "off";
    if (s === "checked_out") counts.checked_out += 1;
    else if (s === "off") counts.off += 1;
  });

  // 통합배치도 대기 패널 목록과 동일
  counts.waiting = countTournamentWaitingDisplay({
    globalWaiting: IX.globalWaiting,
    tournamentId,
    attendanceInactiveUids: inactive,
    globalSeats: IX.dealerGlobalSeats,
    attendanceFilterReady: IX.dealerAttendanceMap.size > 0,
    attendanceWaitingRows: buildIndexAttendanceWaitingRows(IX.dealerAttendanceMap, tournamentId),
    excludeBlocked: false
  });
  counts.assigned = countTournamentOccupiedFromGlobalSeats(IX.dealerGlobalSeats);

  return counts;
}

function renderDealerAdminSummaryHtml(counts) {
  return `
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
          <div class="dealer-metric">
            <div class="dealer-metric-label">미출근</div>
            <div class="dealer-metric-value">${counts.off}</div>
          </div>
        `;
}

function renderDealerAdminListHtml() {
  const baseCount = getAdminAttendanceList().length;
  const list = getFilteredAdminAttendanceList();

  if (!list.length) {
    const emptyText = baseCount
      ? "검색 결과가 없습니다."
      : "아직 출근 기록이 없습니다.";
    return `<div class="dealer-empty">${emptyText}</div>`;
  }

  return list.map((item) => `
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
    <button
      class="dealer-mini-btn dealer-mini-btn--summary"
      type="button"
      data-admin-work-summary
      data-admin-uid="${escapeHtml(item.uid)}"
      data-admin-nickname="${escapeHtml(item.nickname || item.email || "")}"
      title="운영 로그 기준 근무 합계 수정"
    >근무 합계</button>
    <button class="dealer-mini-btn" data-admin-action="checked_out" data-admin-uid="${escapeHtml(item.uid)}" ${item.status === "off" || item.status === "checked_out" ? "disabled" : ""}>퇴근</button>
  </div>
</div>
              `).join("");
}

function canPartialRenderDealerAdmin() {
  if (!IX.dealerOpsMount || IX.dealerUiCollapsed) return false;
  return Boolean(
    IX.dealerOpsMount.querySelector(".dealer-admin-card .dealer-admin-list") &&
    IX.dealerOpsMount.querySelector(".dealer-admin-card [data-dealer-search]")
  );
}

function renderDealerSelfInlineHtml(myStatus) {
  const adminCanCheckIn = myStatus === "off" || myStatus === "checked_out";
  const adminCanCheckOut = myStatus === "waiting";

  return `
          <span class="dealer-status-pill ${escapeHtml(myStatus)}">${escapeHtml(getAttendanceStatusLabel(myStatus))}</span>
          <div class="dealer-action-row dealer-action-row--inline">
            <button class="dealer-action-btn primary" data-self-action="waiting" type="button" ${adminCanCheckIn ? "" : "disabled"}>내 출근</button>
            <button class="dealer-action-btn danger" data-self-action="checked_out" type="button" ${adminCanCheckOut ? "" : "disabled"}>내 퇴근</button>
          </div>
        `;
}

function dealerAdminListFingerprint() {
  const list = getFilteredAdminAttendanceList();
  return list
    .map(
      (item) =>
        `${item.uid}:${item.status || "off"}:${item.nickname || item.email || ""}:${item.currentSeatLabel || ""}:${getWorkingMs(item)}`
    )
    .join("|");
}

/** 실시간 갱신 시 검색창·필터 DOM은 유지하고 요약·목록만 갱신합니다. */
export function renderDealerOpsPartial() {
  refreshIndexDomRefs();
  if (!canPartialRenderDealerAdmin()) {
    renderDealerOps();
    return;
  }

  syncDealerAdminUiFromDom();

  const user = auth.currentUser;
  const me = user ? getDerivedAttendance(user) : null;
  const myStatus = me?.status || "off";
  const nextListFp = dealerAdminListFingerprint();
  const nextSelfFp = `${myStatus}:${me?.checkedInAt || 0}:${me?.checkedOutAt || 0}`;

  const selfInlineEl = IX.dealerOpsMount.querySelector(".dealer-self-inline");
  if (selfInlineEl && nextSelfFp !== IX._dealerSelfFp) {
    IX._dealerSelfFp = nextSelfFp;
    selfInlineEl.innerHTML = renderDealerSelfInlineHtml(myStatus);
  }

  const isAdmin = canShowTournamentOpsUi(
    user?.email,
    IX.currentUserProfile,
    getTournamentId(),
    IX.currentTournament
      ? { id: IX.currentTournament.id, name: IX.currentTournament.name, logoText: IX.currentTournament.logoText }
      : null,
    user?.uid
  );
  syncIndexOpsToolbar(isAdmin);

  const summaryEl = IX.dealerOpsMount.querySelector(".dealer-admin-summary");
  if (summaryEl) summaryEl.innerHTML = renderDealerAdminSummaryHtml(getDealerAdminCounts());

  const listEl = IX.dealerOpsMount.querySelector(".dealer-admin-list");
  if (listEl && nextListFp !== IX._dealerAdminListFp) {
    IX._dealerAdminListFp = nextListFp;
    listEl.innerHTML = renderDealerAdminListHtml();
  }
}

/** 검색·필터·정렬 변경 시 목록만 갱신해 입력 포커스를 유지합니다. */
export function updateDealerAdminList() {
  refreshIndexDomRefs();
  syncDealerAdminUiFromDom();

  const listEl = IX.dealerOpsMount?.querySelector(".dealer-admin-list");
  if (!listEl) {
    renderDealerOps();
    return;
  }
  listEl.innerHTML = renderDealerAdminListHtml();
}

export function renderDealerOps() {
  refreshIndexDomRefs();
  if (!IX.dealerOpsMount) {
    console.warn("renderDealerOps: dealerOpsMount not found");
    return;
  }

  syncDealerAdminUiFromDom();

  const active = document.activeElement;
  const searchFocused = Boolean(active?.closest?.("[data-dealer-search]"));
  const selStart = searchFocused ? active.selectionStart : null;
  const selEnd = searchFocused ? active.selectionEnd : null;

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
  syncIndexOpsToolbar(isAdmin);

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
    const counts = getDealerAdminCounts();

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
        <div class="dealer-self-inline">
          ${renderDealerSelfInlineHtml(myStatus)}
        </div>
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
          ${renderDealerAdminSummaryHtml(counts)}
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
    <option value="off" ${IX.dealerAdminUi.status === "off" ? "selected" : ""}>미출근</option>
  </select>

  <select class="dealer-admin-sort" data-dealer-sort>
    <option value="name" ${IX.dealerAdminUi.sort === "name" ? "selected" : ""}>이름순</option>
    <option value="status" ${IX.dealerAdminUi.sort === "status" ? "selected" : ""}>상태순</option>
    <option value="recent" ${IX.dealerAdminUi.sort === "recent" ? "selected" : ""}>최근 변경순</option>
  </select>
</div>

        <div class="dealer-admin-list">
          ${renderDealerAdminListHtml()}
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
            ? `<button
                type="button"
                class="dealer-time-chip dealer-time-chip--editable"
                data-edit-check-in
                title="탭하여 출근 시각 수정"
                aria-label="출근 시각 수정"
              >
                <span class="dealer-time-chip-label">출근</span>
                <span class="dealer-time-chip-value">${escapeHtml(formatDatetimeKorean(me.checkedInAt))}</span>
                <span class="dealer-time-chip-caret" aria-hidden="true"></span>
              </button>`
            : `<div class="dealer-time-chip">
                <span class="dealer-time-chip-label">출근</span>
                <span class="dealer-time-chip-value">${escapeHtml(myCheckInText)}</span>
              </div>`
        }

        ${
          canEditCheckOut
            ? `<button
                type="button"
                class="dealer-time-chip dealer-time-chip--editable"
                data-edit-check-out
                title="탭하여 퇴근 시각 수정"
                aria-label="퇴근 시각 수정"
              >
                <span class="dealer-time-chip-label">퇴근</span>
                <span class="dealer-time-chip-value">${escapeHtml(formatDatetimeKorean(me.checkedOutAt))}</span>
                <span class="dealer-time-chip-caret" aria-hidden="true"></span>
              </button>`
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

  if (searchFocused) {
    const searchEl = IX.dealerOpsMount.querySelector("[data-dealer-search]");
    searchEl?.focus({ preventScroll: true });
    if (searchEl && selStart != null && selEnd != null) {
      try {
        searchEl.setSelectionRange(selStart, selEnd);
      } catch {
        /* type=search 등 selectionRange 미지원 입력 무시 */
      }
    }
  }

  if (isAdmin && !getAdminAttendanceList().length) {
    void bootstrapIndexDealerOps({ force: true });
  }
}

/** 같은 프레임에서 여러 번 호출돼도 `renderDealerOps`는 한 번만 돌도록 묶습니다. */
export function scheduleRenderDealerOps() {
  if (IX.dealerOpsRenderTimer != null) return;
  IX.dealerOpsRenderTimer = requestAnimationFrame(() => {
    IX.dealerOpsRenderTimer = null;
    if (canPartialRenderDealerAdmin()) {
      renderDealerOpsPartial();
      return;
    }
    renderDealerOps();
  });
}
