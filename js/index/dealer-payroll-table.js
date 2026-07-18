/**
 * 전체 딜러 인건비 표 — 대회 전체 딜러의 정산일별 인건비를 한 화면에서 봅니다.
 * dealer_attendance_logs 를 대회 전체로 한 번에 불러와 딜러별로 묶은 뒤,
 * 이미 만들어둔 computeMyTournamentWorkSummary / buildPayBreakdown 을 그대로 재사용합니다.
 *
 * 속도: 로그/인건비설정 조회(prefetchPayrollData)는 출석·로스터 로딩과 서로 의존성이 없으므로
 * main.js 에서 동시에 시작합니다 — 두 그룹의 Firestore 조회를 순차가 아니라 병렬로 실행해
 * 첫 렌더까지의 대기 시간을 줄입니다.
 */
import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { escapeHtml } from "../shared/dom-utils.js";
import { getTournamentId } from "./core-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { getAdminAttendanceList } from "./dealer-attendance-admin-list.js";
import { computeMyTournamentWorkSummary } from "./dealer-attendance-work-summary.js";
import { loadAllPayProfilesForTournament, defaultPayProfile } from "./dealer-pay-profile.js";
import { buildPayBreakdown, wonLabel } from "./dealer-attendance-pay-calc.js";
import { formatDuration } from "./dealer-attendance-format.js";

const LOG_FETCH_LIMIT = 5000;
const XLSX_CDN_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const PAYROLL_VIEW_PAY = "pay";
const PAYROLL_VIEW_HOURS = "hours";

/**
 * 대회 전체 인건비 계산에 쓰는 로그는 "최근 N건"이 아니라 전체 기간의 로그가 전부 필요합니다.
 * 단일 limit(5000) 조회만 쓰면 로그가 5000건을 넘는(오래 진행되는/인원 많은) 대회에서
 * orderBy asc + limit 특성상 가장 오래된 5000건만 가져오고 최근 근무일 로그가 통째로
 * 누락되어 최근 날짜 인건비가 0으로 계산되는 사고가 납니다 — startAfter로 끝까지 페이지네이션합니다.
 */
async function fetchAllTournamentLogs(tournamentId) {
  const out = [];
  let cursor = null;
  try {
    for (;;) {
      const constraints = [
        collection(db, "dealer_attendance_logs"),
        where("tournamentId", "==", tournamentId),
        orderBy("createdAt", "asc")
      ];
      if (cursor) constraints.push(startAfter(cursor));
      constraints.push(limit(LOG_FETCH_LIMIT));

      const snap = await getDocs(query(...constraints));
      if (snap.empty) break;

      snap.docs.forEach((d) => out.push({ id: d.id, ...(d.data() || {}) }));

      if (snap.docs.length < LOG_FETCH_LIMIT) break;
      cursor = snap.docs[snap.docs.length - 1];
    }
    return out;
  } catch (err) {
    console.warn("fetchAllTournamentLogs:", err?.code || err);
    return out;
  }
}

function groupLogsByUid(logs) {
  const map = new Map();
  for (const log of logs) {
    const uid = String(log.uid || "").trim();
    if (!uid) continue;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(log);
  }
  return map;
}

function buildPayrollRows(adminList, logsByUid, profileMap) {
  return adminList.map((item) => {
    const uid = String(item.uid || "").trim();
    const logs = logsByUid.get(uid) || [];
    const summary = computeMyTournamentWorkSummary({ uid }, logs, item);
    const profile = profileMap.get(uid) || defaultPayProfile(uid);
    const breakdown = buildPayBreakdown(summary.sessions, profile);
    return {
      uid,
      name: String(item.nickname || item.email || uid || "Unknown"),
      email: String(item.email || ""),
      breakdown
    };
  });
}

function collectDayKeys(rows) {
  const set = new Set();
  rows.forEach((r) => r.breakdown.days.forEach((d) => set.add(d.key)));
  return Array.from(set).sort();
}

function dayLabelFor(rows, key) {
  for (const r of rows) {
    const found = r.breakdown.days.find((d) => d.key === key);
    if (found) return found.label;
  }
  return key;
}

function payForDay(row, key) {
  const found = row.breakdown.days.find((d) => d.key === key);
  return found ? found.pay : 0;
}

function msForDay(row, key) {
  const found = row.breakdown.days.find((d) => d.key === key);
  return found ? Math.max(0, Number(found.ms || 0)) : 0;
}

function workDayCount(row) {
  return row.breakdown.days.filter((d) => Number(d.ms || 0) > 0).length;
}

function totalWorkMs(row) {
  return row.breakdown.days.reduce((sum, d) => sum + Math.max(0, Number(d.ms || 0)), 0);
}

function hoursDecimal(ms = 0) {
  const safe = Math.max(0, Number(ms || 0));
  return Math.round((safe / 3_600_000) * 100) / 100;
}

function hoursLabel(ms = 0) {
  const safe = Math.max(0, Number(ms || 0));
  if (!safe) return "-";
  return formatDuration(safe);
}

function filterAndSortRows(rows, keyword = "") {
  const kw = String(keyword || "").trim().toLowerCase();
  return rows
    .filter((r) => !kw || r.name.toLowerCase().includes(kw) || r.email.toLowerCase().includes(kw))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function renderPayrollTableHtml({
  bodyEl,
  searchEl,
  payrollRows,
  payrollDayKeys,
  payrollLoading,
  viewMode = PAYROLL_VIEW_PAY
}) {
  if (!bodyEl) return;

  if (payrollLoading) {
    bodyEl.innerHTML = `<p class="payroll-table-empty">불러오는 중…</p>`;
    return;
  }

  const rows = filterAndSortRows(payrollRows, searchEl?.value || "");

  if (!rows.length) {
    bodyEl.innerHTML = `<p class="payroll-table-empty">표시할 딜러가 없습니다.</p>`;
    return;
  }

  if (viewMode === PAYROLL_VIEW_HOURS) {
    bodyEl.innerHTML = renderHoursTableInner(rows, payrollRows, payrollDayKeys);
    return;
  }

  bodyEl.innerHTML = renderPayTableInner(rows, payrollRows, payrollDayKeys);
}

function renderPayTableInner(rows, payrollRows, dayKeys) {
  const headCells = dayKeys
    .map((k) => `<th>${escapeHtml(dayLabelFor(payrollRows, k))}</th>`)
    .join("");

  const bodyRows = rows
    .map((r) => {
      const dayCells = dayKeys
        .map((k) => {
          const pay = payForDay(r, k);
          return `<td class="${pay ? "" : "is-zero"}">${pay ? wonLabel(pay) : "-"}</td>`;
        })
        .join("");
      return `
      <tr>
        <td class="payroll-table-name">${escapeHtml(r.name)}</td>
        ${dayCells}
        <td>${r.breakdown.extrasTotal ? wonLabel(r.breakdown.extrasTotal) : "-"}</td>
        <td>${wonLabel(r.breakdown.workTotal)}</td>
        <td class="payroll-table-grand">${wonLabel(r.breakdown.grandTotal)}</td>
      </tr>`;
    })
    .join("");

  const totalsByDay = dayKeys.map((k) => rows.reduce((a, r) => a + payForDay(r, k), 0));
  const totalExtras = rows.reduce((a, r) => a + r.breakdown.extrasTotal, 0);
  const totalWork = rows.reduce((a, r) => a + r.breakdown.workTotal, 0);
  const totalGrand = rows.reduce((a, r) => a + r.breakdown.grandTotal, 0);

  const totalsRow = `
    <tr class="payroll-table-totals">
      <td>합계</td>
      ${totalsByDay.map((v) => `<td>${v ? wonLabel(v) : "-"}</td>`).join("")}
      <td>${totalExtras ? wonLabel(totalExtras) : "-"}</td>
      <td>${wonLabel(totalWork)}</td>
      <td class="payroll-table-grand">${wonLabel(totalGrand)}</td>
    </tr>`;

  return `
    <div class="payroll-table-wrap">
      <table class="payroll-table">
        <thead>
          <tr>
            <th class="payroll-table-name">이름</th>
            ${headCells}
            <th>부가비용</th>
            <th>근무비 TOTAL</th>
            <th>최종지급액</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
          ${totalsRow}
        </tbody>
      </table>
    </div>
  `;
}

function renderHoursTableInner(rows, payrollRows, dayKeys) {
  const headCells = dayKeys
    .map((k) => `<th>${escapeHtml(dayLabelFor(payrollRows, k))}</th>`)
    .join("");

  const bodyRows = rows
    .map((r) => {
      const dayCells = dayKeys
        .map((k) => {
          const ms = msForDay(r, k);
          return `<td class="${ms ? "" : "is-zero"}">${escapeHtml(hoursLabel(ms))}</td>`;
        })
        .join("");
      return `
      <tr>
        <td class="payroll-table-name">${escapeHtml(r.name)}</td>
        ${dayCells}
        <td>${workDayCount(r) ? `${workDayCount(r)}일` : "-"}</td>
        <td class="payroll-table-grand">${escapeHtml(hoursLabel(totalWorkMs(r)))}</td>
      </tr>`;
    })
    .join("");

  const totalsByDayMs = dayKeys.map((k) => rows.reduce((a, r) => a + msForDay(r, k), 0));
  const totalDays = rows.reduce((a, r) => a + workDayCount(r), 0);
  const totalMs = rows.reduce((a, r) => a + totalWorkMs(r), 0);

  const totalsRow = `
    <tr class="payroll-table-totals">
      <td>합계</td>
      ${totalsByDayMs.map((ms) => `<td>${ms ? escapeHtml(hoursLabel(ms)) : "-"}</td>`).join("")}
      <td>${totalDays ? `${totalDays}일` : "-"}</td>
      <td class="payroll-table-grand">${escapeHtml(hoursLabel(totalMs))}</td>
    </tr>`;

  return `
    <div class="payroll-table-wrap">
      <table class="payroll-table payroll-table--hours">
        <thead>
          <tr>
            <th class="payroll-table-name">이름</th>
            ${headCells}
            <th>근무 일수</th>
            <th>총 근무 시간</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
          ${totalsRow}
        </tbody>
      </table>
    </div>
  `;
}

/** 정산일 키(YYYY-MM-DD)를 엑셀 친화적인 파일명 조각으로 */
function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function buildPaySheetAoa(rows, payrollDayKeys, payrollRows) {
  const header = [
    "이름",
    ...payrollDayKeys.map((k) => dayLabelFor(payrollRows, k)),
    "부가비용",
    "근무비 TOTAL",
    "최종지급액"
  ];

  const body = rows.map((r) => [
    r.name,
    ...payrollDayKeys.map((k) => payForDay(r, k)),
    r.breakdown.extrasTotal,
    r.breakdown.workTotal,
    r.breakdown.grandTotal
  ]);

  const totalsByDay = payrollDayKeys.map((k) => rows.reduce((a, r) => a + payForDay(r, k), 0));
  const totalExtras = rows.reduce((a, r) => a + r.breakdown.extrasTotal, 0);
  const totalWork = rows.reduce((a, r) => a + r.breakdown.workTotal, 0);
  const totalGrand = rows.reduce((a, r) => a + r.breakdown.grandTotal, 0);
  body.push(["합계", ...totalsByDay, totalExtras, totalWork, totalGrand]);

  return [header, ...body];
}

function buildHoursSheetAoa(rows, payrollDayKeys, payrollRows) {
  const header = [
    "이름",
    ...payrollDayKeys.map((k) => `${dayLabelFor(payrollRows, k)} (시간)`),
    "근무 일수",
    "총 근무(시간)"
  ];

  const body = rows.map((r) => [
    r.name,
    ...payrollDayKeys.map((k) => {
      const ms = msForDay(r, k);
      return ms > 0 ? hoursDecimal(ms) : "";
    }),
    workDayCount(r) || "",
    hoursDecimal(totalWorkMs(r)) || ""
  ]);

  const totalsByDayMs = payrollDayKeys.map((k) => rows.reduce((a, r) => a + msForDay(r, k), 0));
  const totalDays = rows.reduce((a, r) => a + workDayCount(r), 0);
  const totalMs = rows.reduce((a, r) => a + totalWorkMs(r), 0);
  body.push([
    "합계",
    ...totalsByDayMs.map((ms) => (ms > 0 ? hoursDecimal(ms) : "")),
    totalDays || "",
    hoursDecimal(totalMs) || ""
  ]);

  return [header, ...body];
}

let xlsxModulePromise = null;

function resolveXlsxModule(mod = {}) {
  if (mod?.utils && typeof mod.writeFile === "function") return mod;
  if (mod?.default?.utils && typeof mod.default.writeFile === "function") return mod.default;
  throw new Error("XLSX module unavailable");
}

function loadXlsxModule() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import(/* @vite-ignore */ XLSX_CDN_URL)
      .then(resolveXlsxModule)
      .catch((err) => {
        xlsxModulePromise = null;
        throw err;
      });
  }
  return xlsxModulePromise;
}

async function exportPayrollExcel(payrollRows, payrollDayKeys, keyword = "") {
  const rows = filterAndSortRows(payrollRows, keyword);
  if (!rows.length) return false;

  const XLSX = await loadXlsxModule();

  const payAoa = buildPaySheetAoa(rows, payrollDayKeys, payrollRows);
  const hoursAoa = buildHoursSheetAoa(rows, payrollDayKeys, payrollRows);

  const wsPay = XLSX.utils.aoa_to_sheet(payAoa);
  wsPay["!cols"] = payAoa[0].map((_, i) => ({ wch: i === 0 ? 12 : 13 }));

  const wsHours = XLSX.utils.aoa_to_sheet(hoursAoa);
  wsHours["!cols"] = hoursAoa[0].map((_, i) => ({ wch: i === 0 ? 12 : 13 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsPay, "인건비");
  XLSX.utils.book_append_sheet(wb, wsHours, "근무시간");

  const tournamentId = getTournamentId() || "tournament";
  XLSX.writeFile(wb, `한핏_인건비_${tournamentId}_${todayStamp()}.xlsx`);
  return true;
}

export function createPayrollTableView({ bodyEl, searchEl, exportEl, tabsEl } = {}) {
  let payrollRows = [];
  let payrollDayKeys = [];
  let payrollLoading = false;
  let prefetchPromise = null;
  let viewMode = PAYROLL_VIEW_PAY;

  function resolveTabsEl() {
    return tabsEl || document.getElementById("payrollViewTabs");
  }

  function syncTabState() {
    resolveTabsEl()?.querySelectorAll("[data-payroll-view]").forEach((btn) => {
      const active = btn.dataset.payrollView === viewMode;
      btn.classList.toggle("active", active);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function setViewMode(next) {
    const mode = String(next || "").trim();
    if (mode !== PAYROLL_VIEW_PAY && mode !== PAYROLL_VIEW_HOURS) return;
    if (mode === viewMode) return;
    viewMode = mode;
    renderPayrollTable();
  }

  function renderPayrollTable() {
    renderPayrollTableHtml({
      bodyEl,
      searchEl,
      payrollRows,
      payrollDayKeys,
      payrollLoading,
      viewMode
    });
    syncTabState();
  }

  function setLoading() {
    payrollLoading = true;
    renderPayrollTable();
  }

  /**
   * dealer_attendance_logs / dealer_pay_profiles 조회를 즉시 시작합니다.
   * getAdminAttendanceList() 에 필요한 출석·로스터 로딩과는 서로 무관하므로
   * 호출자(main.js)가 이 두 그룹을 동시에 시작해 대기 시간을 줄일 수 있습니다.
   */
  function prefetchPayrollData(tournamentId = getTournamentId()) {
    if (!prefetchPromise) {
      prefetchPromise = tournamentId
        ? Promise.all([fetchAllTournamentLogs(tournamentId), loadAllPayProfilesForTournament()])
        : Promise.resolve([[], new Map()]);
    }
    return prefetchPromise;
  }

  async function loadPayrollTable() {
    payrollLoading = true;
    renderPayrollTable();

    const tournamentId = getTournamentId();
    if (!tournamentId) {
      payrollLoading = false;
      renderPayrollTable();
      return;
    }

    const [logs, profileMap] = await prefetchPayrollData(tournamentId);

    const adminList = getAdminAttendanceList();
    const logsByUid = groupLogsByUid(logs);
    payrollRows = buildPayrollRows(adminList, logsByUid, profileMap);
    payrollDayKeys = collectDayKeys(payrollRows);

    payrollLoading = false;
    renderPayrollTable();
  }

  async function handleExportClick() {
    if (!exportEl || exportEl.disabled) return;
    if (!payrollRows.length) {
      alert("내보낼 데이터가 없습니다.");
      return;
    }

    const prevText = exportEl.textContent;
    exportEl.disabled = true;
    exportEl.textContent = "내보내는 중…";
    try {
      const ok = await exportPayrollExcel(payrollRows, payrollDayKeys, searchEl?.value || "");
      if (!ok) alert("내보낼 데이터가 없습니다.");
    } catch (err) {
      console.warn("payroll excel export:", err);
      alert("엑셀 파일을 만드는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      exportEl.disabled = false;
      exportEl.textContent = prevText;
    }
  }

  function bindExportButton(el = exportEl) {
    if (!el || el.dataset.payrollExportBound === "1") return;
    el.dataset.payrollExportBound = "1";
    el.addEventListener("click", (e) => {
      e.preventDefault();
      void handleExportClick();
    });
  }

  function bindViewTabs(el = resolveTabsEl()) {
    if (!el || el.dataset.payrollTabsBound === "1") return;
    el.dataset.payrollTabsBound = "1";
    el.querySelectorAll("[data-payroll-view]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        setViewMode(btn.dataset.payrollView);
      });
    });
  }

  searchEl?.addEventListener("input", () => renderPayrollTable());
  bindViewTabs();
  bindExportButton(exportEl);

  return {
    loadPayrollTable,
    renderPayrollTable,
    prefetchPayrollData,
    setLoading,
    exportPayrollExcel: handleExportClick,
    bindExportButton,
    bindViewTabs
  };
}

export function buildPayrollPageHref(tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  if (!tid) return "./payroll.html";
  return `./payroll.html?tournamentId=${encodeURIComponent(tid)}`;
}

let payrollPageNavBound = false;

export function setupPayrollPageNav() {
  refreshIndexDomRefs();
  if (payrollPageNavBound) return;
  if (!IX.payrollTableBtn) return;
  payrollPageNavBound = true;
  IX.payrollTableBtn.addEventListener("click", () => {
    const tid = getTournamentId();
    if (!tid) {
      alert("대회 정보가 없습니다.");
      return;
    }
    sessionStorage.setItem("tournamentId", tid);
    location.href = buildPayrollPageHref(tid);
  });
}
