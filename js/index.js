import { auth, db } from "./firebase.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

console.log("🔥 index.js loaded");

import { isAdminEmail, APP_TIME_ZONE } from "./app_config.js";

function getIsAdmin(user, profile) {
  return (
    profile?.role === "admin" ||
    isAdminEmail(user?.email || "")
  );
}

const root = document.getElementById("indexRoot");
const backBtn = document.getElementById("backBtn");
const topbarTournamentName = document.getElementById("topbarTournamentName");

const eventAdminBtn = document.getElementById("eventAdminBtn");
const attendanceLogBtn = document.getElementById("attendanceLogBtn");
const attendanceLogModal = document.getElementById("attendanceLogModal");
const closeAttendanceLogBtn = document.getElementById("closeAttendanceLogBtn");
const attendanceLogSearch = document.getElementById("attendanceLogSearch");
const attendanceLogActionFilter = document.getElementById("attendanceLogActionFilter");
const attendanceLogSummary = document.getElementById("attendanceLogSummary");
const attendanceLogList = document.getElementById("attendanceLogList");
const clearAttendanceLogsBtn = document.getElementById("clearAttendanceLogsBtn");
const deleteSelectedAttendanceLogsBtn = document.getElementById("deleteSelectedAttendanceLogsBtn");

const seatMapEditBtn = document.getElementById("seatMapEditBtn");
const eventAdminModal = document.getElementById("eventAdminModal");
const closeEventAdminBtn = document.getElementById("closeEventAdminBtn");

const eventCardSelect = document.getElementById("eventCardSelect");
const eventCardId = document.getElementById("eventCardId");
const eventCardBoxId = document.getElementById("eventCardBoxId");
const eventCardDate = document.getElementById("eventCardDate");
const eventCardTitle = document.getElementById("eventCardTitle");
const eventCardStart = document.getElementById("eventCardStart");
const eventCardClose = document.getElementById("eventCardClose");

const newEventCardBtn = document.getElementById("newEventCardBtn");
const saveEventCardBtn = document.getElementById("saveEventCardBtn");
const deleteEventCardBtn = document.getElementById("deleteEventCardBtn");
const eventCardList = document.getElementById("eventCardList");
const dealerOpsMount = document.getElementById("dealerOpsMount");

let stopDealerAttendanceWatch = null;
let stopDealerSeatWatch = null;
let stopAttendanceLogsWatch = null;
let attendanceLogEventsBound = false;

const attendanceLogUi = {
  search: "",
  action: "all",
  selectedIds: new Set()
};

let attendanceLogs = [];

let dealerAttendanceMap = new Map();
let dealerSeatMap = new Map();

const dealerAdminUi = {
  search: "",
  status: "all",
  sort: "name"
};

let dealerOpsRenderTimer = null;

function scheduleRenderDealerOps() {
  if (dealerOpsRenderTimer) clearTimeout(dealerOpsRenderTimer);
  dealerOpsRenderTimer = setTimeout(() => {
    renderDealerOps();
  }, 50);
}

let events = [];
let currentTournament = null;
let currentUserProfile = null;
let currentSeatAssignment = null;
let seatSummaryMap = new Map();
let dealerUiCollapsed = true;

let stopTournamentWatch = null;
let stopMySeatNotificationWatch = null;
let stopEventsWatch = null;
let stopLayoutEventsWatch = null;
let periodBlocked = false;

/* ===============================
   ROUTE
=============================== */
function getTournamentId() {
  const params = new URLSearchParams(location.search);
  return (
    params.get("tournamentId") ||
    sessionStorage.getItem("tournamentId") ||
    ""
  );
}

function ensureTournamentContextOrAlert() {
  const tournamentId = getTournamentId();
  if (tournamentId) return tournamentId;
  alert("대회 정보가 없어 허브로 이동합니다.");
  location.replace("./hub.html");
  return "";
}

function isValidDocId(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/");
}

function chunkArray(list = [], size = 200) {
  const safe = Array.isArray(list) ? list : [];
  const chunkSize = Math.max(1, Number(size || 1));
  const chunks = [];
  for (let i = 0; i < safe.length; i += chunkSize) {
    chunks.push(safe.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms || 0)));
  });
}

async function commitBatchWithRetry(batch, options = {}) {
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250));
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await batch.commit();
      return true;
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}

/* ===============================
   TIME HELPERS
=============================== */
function getNowPartsInAppTimeZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function getNowInAppTime() {
  const p = getNowPartsInAppTimeZone();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

function normalizeDateString(date) {
  return String(date || "").trim().replaceAll(".", "-").replaceAll("/", "-");
}

function parseDateTime(date, time) {
  const safeDate = normalizeDateString(date);
  const safeTime = String(time || "").trim();

  if (!safeDate || !safeTime) return null;

  const [yy, mm, dd] = safeDate.split("-").map(Number);
  const [hh, mi] = safeTime.split(":").map(Number);

  if (!yy || !mm || !dd) return null;
  if (!Number.isFinite(hh) || !Number.isFinite(mi)) return null;

  const d = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ===============================
   UTIL
=============================== */
function formatDateTitle(dateStr) {
  const safeDate = normalizeDateString(dateStr);
  const d = parseDateTime(safeDate, "00:00");
  if (!d) return String(dateStr || "Unknown Date");

  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    weekday: "long",
    year: "numeric"
  });
}

function parseTournamentDate(str) {
  if (!str || typeof str !== "string") return null;

  const safe = normalizeDateString(str);
  const parts = safe.split("-");
  if (parts.length !== 3) return null;

  let yy = Number(parts[0]);
  const mm = Number(parts[1]);
  const dd = Number(parts[2]);

  if (!yy || !mm || !dd) return null;
  if (yy < 100) yy = 2000 + yy;

  return new Date(yy, mm - 1, dd, 23, 59, 59, 999);
}

function isTournamentActive(tournament) {
  if (!tournament) return true;

  const now = getNowInAppTime();
  const start = parseTournamentDate(tournament.startDate);
  const end = parseTournamentDate(tournament.endDate);

  if (!start || !end) return true;

  const startOfDay = new Date(start);
  startOfDay.setHours(0, 0, 0, 0);

  return !(now < startOfDay || now > end);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openModal(el) {
  el?.classList.add("show");
}

function closeModal(el) {
  el?.classList.remove("show");
}
/* ===============================
   DEALER ATTENDANCE
=============================== */
function getAttendanceDocId(tournamentId, uid) {
  return `${tournamentId}__${uid}`;
}

function getAttendanceRef(tournamentId, uid) {
  return doc(db, "dealer_attendance", getAttendanceDocId(tournamentId, uid));
}

function getAttendanceStatusLabel(status) {
  if (status === "checked_in") return "출근 완료";
  if (status === "waiting") return "대기";
  if (status === "assigned") return "배치중";
  if (status === "break") return "휴식";
  if (status === "checked_out") return "퇴근";
  return "출근 전";
}

function formatClock(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}
function formatClockOrDash(ts) {
  return ts ? formatClock(ts) : "-";
}

function formatDuration(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const totalMin = Math.floor(safe / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}시간 ${String(m).padStart(2, "0")}분`;
}

function getNowMs() {
  return Date.now();
}

function getBaseAttendance(user) {
  if (!user) return null;
  const tournamentId = getTournamentId();
  return dealerAttendanceMap.get(getAttendanceDocId(tournamentId, user.uid)) || null;
}

function getDerivedAttendance(user) {
  if (!user) return null;

  const base = getBaseAttendance(user);
  const seatInfo = dealerSeatMap.get(user.uid);

  if (!base) {
    return {
      uid: user.uid,
      nickname: currentUserProfile?.nickname || user.displayName || "Unknown",
      status: seatInfo ? "assigned" : "off",
      checkedInAt: null,
      checkedOutAt: null,
      breakStartedAt: null,
      totalBreakMs: 0,
      currentEventId: seatInfo?.eventId || "",
      currentBoxId: seatInfo?.boxId || "",
      currentSeatId: seatInfo?.seatId || "",
      currentSeatLabel: seatInfo?.seatLabel || "",
      updatedAt: 0
    };
  }

  return {
    ...base,
    status: seatInfo ? "assigned" : base.status,
    currentEventId: seatInfo?.eventId || base.currentEventId || "",
    currentBoxId: seatInfo?.boxId || base.currentBoxId || "",
    currentSeatId: seatInfo?.seatId || base.currentSeatId || "",
    currentSeatLabel: seatInfo?.seatLabel || base.currentSeatLabel || ""
  };
}

async function writeAttendanceLog({
  uid = "",
  nickname = "",
  action = "",
  tournamentId = "",
  eventId = "",
  boxId = "",
  seatId = "",
  seatLabel = ""
}) {
  try {
    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await setDoc(doc(db, "dealer_attendance_logs", logId), {
      uid,
      nickname,
      action,
      tournamentId,
      eventId,
      boxId,
      seatId,
      seatLabel,
      createdAt: Date.now()
    });
  } catch (err) {
    console.error("writeAttendanceLog error:", err);
  }
}

async function updateMyAttendanceStatus(nextStatus) {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !currentUserProfile) return;

  const current = getDerivedAttendance(user);
  const now = getNowMs();

  const payload = {
    uid: user.uid,
    nickname: String(currentUserProfile.nickname || user.displayName || "").trim(),
    email: String(currentUserProfile.email || user.email || "").trim(),
    tournamentId,
    status: nextStatus,
    checkedInAt:
      nextStatus === "checked_in" || nextStatus === "waiting" || nextStatus === "break"
        ? (current?.checkedInAt || now)
        : (current?.checkedInAt || null),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt:
      nextStatus === "break"
        ? now
        : null,
    totalBreakMs:
      nextStatus === "waiting" && current?.status === "break" && current?.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current?.totalBreakMs || 0),
    currentEventId: current?.currentEventId || "",
    currentBoxId: current?.currentBoxId || "",
    currentSeatId: current?.currentSeatId || "",
    currentSeatLabel: current?.currentSeatLabel || "",
    updatedAt: now
  };

  await setDoc(getAttendanceRef(tournamentId, user.uid), payload, { merge: true });

  await writeAttendanceLog({
  uid: user.uid,
  nickname: String(currentUserProfile.nickname || user.displayName || "").trim(),
  action: nextStatus,
  tournamentId,
  eventId: current?.currentEventId || "",
  boxId: current?.currentBoxId || "",
  seatId: current?.currentSeatId || "",
  seatLabel: current?.currentSeatLabel || ""
});
}

async function updateAdminAttendanceStatus(uid, nextStatus) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!uid || !tournamentId) return;

  const current = dealerAttendanceMap.get(getAttendanceDocId(tournamentId, uid));
  if (!current) return;

  const now = getNowMs();

  const payload = {
    ...current,
    status: nextStatus,
    checkedInAt:
      nextStatus === "checked_in" || nextStatus === "waiting" || nextStatus === "break"
        ? (current.checkedInAt || now)
        : (current.checkedInAt || null),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt: nextStatus === "break" ? now : null,
    totalBreakMs:
      nextStatus === "waiting" && current.status === "break" && current.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current.totalBreakMs || 0),
    updatedAt: now
  };

  await setDoc(getAttendanceRef(tournamentId, uid), payload, { merge: true });

  await writeAttendanceLog({
  uid,
  nickname: String(current.nickname || "").trim(),
  action: nextStatus,
  tournamentId,
  eventId: current?.currentEventId || "",
  boxId: current?.currentBoxId || "",
  seatId: current?.currentSeatId || "",
  seatLabel: current?.currentSeatLabel || ""
});
}

function getAttendanceActionLabel(action) {
  if (action === "checked_in") return "출근";
  if (action === "waiting") return "대기";
  if (action === "assigned") return "배치";
  if (action === "break") return "휴식";
  if (action === "checked_out") return "퇴근";
  return action || "기타";
}

function escapeAttr(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatLogDateTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getAttendanceLogDescription(log) {
  const actionLabel = getAttendanceActionLabel(log.action);
  const nickname = String(log.nickname || "이름 없음").trim();
  const seatLabel = String(log.seatLabel || "").trim();
  const eventId = String(log.eventId || "").trim();
  const boxId = String(log.boxId || "").trim();

  const parts = [`${nickname} · ${actionLabel}`];

  if (seatLabel) parts.push(`Seat ${seatLabel}`);
  if (eventId) parts.push(`Event ${eventId}`);
  if (boxId) parts.push(`Box ${boxId}`);

  return parts.join(" / ");
}

function getFilteredAttendanceLogs() {
  const tournamentId = getTournamentId();
  const keyword = String(attendanceLogUi.search || "").trim().toLowerCase();
  const actionFilter = String(attendanceLogUi.action || "all").trim();

  return attendanceLogs.filter((log) => {
    const sameTournament =
      !tournamentId || String(log.tournamentId || "").trim() === tournamentId;

    const haystack = [
      log.nickname || "",
      log.action || "",
      log.eventId || "",
      log.boxId || "",
      log.seatLabel || "",
      log.uid || ""
    ].join(" ").toLowerCase();

    const matchedKeyword = !keyword || haystack.includes(keyword);
    const matchedAction = actionFilter === "all" || String(log.action || "") === actionFilter;

    return sameTournament && matchedKeyword && matchedAction;
  });
}

function updateAttendanceLogSummary() {
  if (!attendanceLogSummary) return;

  const filtered = getFilteredAttendanceLogs();
  const total = filtered.length;
  const selected = filtered.filter((log) => attendanceLogUi.selectedIds.has(log.id)).length;

  attendanceLogSummary.textContent =
    total === 0
      ? "최근 로그 0건"
      : `최근 로그 ${total}건${selected > 0 ? ` · 선택 ${selected}건` : ""}`;
}

function renderAttendanceLogs() {
  if (!attendanceLogList) return;

  const filtered = getFilteredAttendanceLogs();

  updateAttendanceLogSummary();

  if (!filtered.length) {
    attendanceLogList.innerHTML = `
      <div class="attendance-log-empty">
        표시할 운영 로그가 없습니다.
      </div>
    `;
    return;
  }

  attendanceLogList.innerHTML = filtered.map((log) => {
    const id = String(log.id || "");
    const checked = attendanceLogUi.selectedIds.has(id);
    const action = String(log.action || "").trim();
    const nickname = escapeHtml(log.nickname || "이름 없음");
    const timeText = formatLogDateTime(log.createdAt);
    const desc = escapeHtml(getAttendanceLogDescription(log));

    const meta = [];

    meta.push(
      `<span class="attendance-log-pill strong">${escapeHtml(getAttendanceActionLabel(action))}</span>`
    );

    if (log.eventId) {
      meta.push(`<span class="attendance-log-pill">Event ${escapeHtml(log.eventId)}</span>`);
    }

    if (log.boxId) {
      meta.push(`<span class="attendance-log-pill">Box ${escapeHtml(log.boxId)}</span>`);
    }

    if (log.seatLabel) {
      meta.push(`<span class="attendance-log-pill">Seat ${escapeHtml(log.seatLabel)}</span>`);
    }

    return `
      <div class="attendance-log-item action-${escapeAttr(action)}" data-log-id="${escapeAttr(id)}">
        <div class="attendance-log-top">
          <div class="attendance-log-top-left">
            <input
              class="attendance-log-check"
              type="checkbox"
              data-log-check="${escapeAttr(id)}"
              ${checked ? "checked" : ""}
            />
            <div class="attendance-log-name">${nickname}</div>
          </div>
          <div class="attendance-log-time">${escapeHtml(timeText)}</div>
        </div>

        <div class="attendance-log-meta">
          ${meta.join("")}
        </div>

        <div class="attendance-log-desc">${desc}</div>
      </div>
    `;
  }).join("");
}

function bindAttendanceLogsRealtime() {
  if (stopAttendanceLogsWatch) {
    stopAttendanceLogsWatch();
    stopAttendanceLogsWatch = null;
  }

  stopAttendanceLogsWatch = onSnapshot(
    collection(db, "dealer_attendance_logs"),
    (snap) => {
      attendanceLogs = snap.docs
        .map((d) => ({
          id: d.id,
          ...(d.data() || {})
        }))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      const validIds = new Set(attendanceLogs.map((log) => String(log.id || "")));
      attendanceLogUi.selectedIds.forEach((id) => {
        if (!validIds.has(id)) {
          attendanceLogUi.selectedIds.delete(id);
        }
      });

      renderAttendanceLogs();
    },
    (err) => {
      console.error("bindAttendanceLogsRealtime error:", err);
    }
  );
}

function openAttendanceLogModal() {
  renderAttendanceLogs();
  openModal(attendanceLogModal);
}

function closeAttendanceLogModal() {
  closeModal(attendanceLogModal);
}

async function deleteSelectedAttendanceLogs() {
  const ids = Array.from(attendanceLogUi.selectedIds);
  if (!ids.length) {
    alert("선택된 로그가 없습니다.");
    return;
  }

  const ok = confirm(`선택한 로그 ${ids.length}건을 삭제할까요?`);
  if (!ok) return;

  try {
    await Promise.all(
      ids.map((id) => deleteDoc(doc(db, "dealer_attendance_logs", id)))
    );

    attendanceLogUi.selectedIds.clear();
  } catch (err) {
    console.error("deleteSelectedAttendanceLogs error:", err);
    alert("선택 로그 삭제에 실패했습니다.");
  }
}

async function clearAttendanceLogs() {
  const filtered = getFilteredAttendanceLogs();
  if (!filtered.length) {
    alert("삭제할 로그가 없습니다.");
    return;
  }

  const ok = confirm(`현재 보이는 로그 ${filtered.length}건을 전체 삭제할까요?`);
  if (!ok) return;

  try {
    await Promise.all(
      filtered.map((log) => deleteDoc(doc(db, "dealer_attendance_logs", log.id)))
    );

    attendanceLogUi.selectedIds.clear();
  } catch (err) {
    console.error("clearAttendanceLogs error:", err);
    alert("전체 로그 초기화에 실패했습니다.");
  }
}

function setupAttendanceLogEvents() {
  if (attendanceLogEventsBound) return;
  attendanceLogEventsBound = true;

  attendanceLogBtn?.addEventListener("click", () => {
    const isAdmin = getIsAdmin(auth.currentUser, currentUserProfile);
    if (!isAdmin) return;
    openAttendanceLogModal();
  });

  closeAttendanceLogBtn?.addEventListener("click", closeAttendanceLogModal);

  attendanceLogModal?.addEventListener("click", (e) => {
    if (e.target === attendanceLogModal) {
      closeAttendanceLogModal();
    }
  });

  attendanceLogSearch?.addEventListener("input", (e) => {
    attendanceLogUi.search = String(e.target.value || "");
    renderAttendanceLogs();
  });

  attendanceLogActionFilter?.addEventListener("change", (e) => {
    attendanceLogUi.action = String(e.target.value || "all");
    renderAttendanceLogs();
  });

  attendanceLogList?.addEventListener("change", (e) => {
    const checkbox = e.target.closest("[data-log-check]");
    if (!checkbox) return;

    const id = String(checkbox.getAttribute("data-log-check") || "").trim();
    if (!id) return;

    if (checkbox.checked) {
      attendanceLogUi.selectedIds.add(id);
    } else {
      attendanceLogUi.selectedIds.delete(id);
    }

    updateAttendanceLogSummary();
  });

  deleteSelectedAttendanceLogsBtn?.addEventListener("click", deleteSelectedAttendanceLogs);
  clearAttendanceLogsBtn?.addEventListener("click", clearAttendanceLogs);
}

function getWorkingMs(item) {
  if (!item?.checkedInAt) return 0;
  const end = item.status === "checked_out" && item.checkedOutAt ? item.checkedOutAt : Date.now();
  const total = Math.max(0, end - Number(item.checkedInAt || 0));
  const currentBreak =
    item.status === "break" && item.breakStartedAt
      ? Math.max(0, Date.now() - Number(item.breakStartedAt || 0))
      : 0;
  return Math.max(0, total - Number(item.totalBreakMs || 0) - currentBreak);
}

function getAdminAttendanceList() {
  const tournamentId = getTournamentId();
  const list = [];

  dealerAttendanceMap.forEach((value) => {
    if (value.tournamentId !== tournamentId) return;
    const derived = {
      ...value,
      ...(dealerSeatMap.get(value.uid)
        ? {
            status: "assigned",
            currentEventId: dealerSeatMap.get(value.uid)?.eventId || "",
            currentBoxId: dealerSeatMap.get(value.uid)?.boxId || "",
            currentSeatId: dealerSeatMap.get(value.uid)?.seatId || "",
            currentSeatLabel: dealerSeatMap.get(value.uid)?.seatLabel || ""
          }
        : {})
    };
    list.push(derived);
  });

  list.sort((a, b) => (a.nickname || "").localeCompare(b.nickname || "", "ko"));
  return list;
}
function getFilteredAdminAttendanceList() {
  const base = getAdminAttendanceList();

  const keyword = dealerAdminUi.search.trim().toLowerCase();
  let list = base.filter((item) => {
    const name = String(item.nickname || "").toLowerCase();
    const email = String(item.email || "").toLowerCase();
    const status = String(item.status || "off").trim();

    const matchKeyword =
      !keyword ||
      name.includes(keyword) ||
      email.includes(keyword);

    const matchStatus =
      dealerAdminUi.status === "all" ||
      status === dealerAdminUi.status;

    return matchKeyword && matchStatus;
  });

  if (dealerAdminUi.sort === "name") {
    list.sort((a, b) =>
      String(a.nickname || "").localeCompare(String(b.nickname || ""), "ko")
    );
  }

  if (dealerAdminUi.sort === "status") {
    const order = {
      waiting: 1,
      assigned: 2,
      checked_out: 3,
      off: 4
    };

    list.sort((a, b) => {
      const ao = order[String(a.status || "off")] ?? 99;
      const bo = order[String(b.status || "off")] ?? 99;
      if (ao !== bo) return ao - bo;
      return String(a.nickname || "").localeCompare(String(b.nickname || ""), "ko");
    });
  }

  if (dealerAdminUi.sort === "recent") {
    list.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  return list;
}

function renderDealerOps() {
  if (!dealerOpsMount) return;

const user = auth.currentUser;
const isAdmin = getIsAdmin(user, currentUserProfile);
  const me = user ? getDerivedAttendance(user) : null;

  const myStatus = me?.status || "off";
  const canCheckIn = myStatus === "off" || myStatus === "checked_out";
  const canCheckOut = myStatus === "waiting";

  const myCheckInText = formatClockOrDash(me?.checkedInAt);
  const myCheckOutText = formatClockOrDash(me?.checkedOutAt);

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

if (isAdmin && dealerUiCollapsed) {
  dealerOpsMount.innerHTML = `
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
  ${dealerUiCollapsed ? "▼" : "▲"}
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
    placeholder="이름 또는 이메일 검색"
    value="${escapeHtml(dealerAdminUi.search)}"
    data-dealer-search
  />

  <select class="dealer-admin-filter" data-dealer-filter>
    <option value="all" ${dealerAdminUi.status === "all" ? "selected" : ""}>전체</option>
    <option value="waiting" ${dealerAdminUi.status === "waiting" ? "selected" : ""}>대기</option>
    <option value="assigned" ${dealerAdminUi.status === "assigned" ? "selected" : ""}>배치중</option>
    <option value="checked_out" ${dealerAdminUi.status === "checked_out" ? "selected" : ""}>퇴근</option>
  </select>

  <select class="dealer-admin-sort" data-dealer-sort>
    <option value="name" ${dealerAdminUi.sort === "name" ? "selected" : ""}>이름순</option>
    <option value="status" ${dealerAdminUi.sort === "status" ? "selected" : ""}>상태순</option>
    <option value="recent" ${dealerAdminUi.sort === "recent" ? "selected" : ""}>최근 변경순</option>
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
        <div class="dealer-time-chip">
          <span class="dealer-time-chip-label">출근</span>
          <span class="dealer-time-chip-value">${escapeHtml(myCheckInText)}</span>
        </div>

        <div class="dealer-time-chip">
          <span class="dealer-time-chip-label">퇴근</span>
          <span class="dealer-time-chip-value">${escapeHtml(myCheckOutText)}</span>
        </div>
      </div>

      <div class="dealer-action-row">
        <button class="dealer-action-btn primary" data-self-action="waiting" ${canCheckIn ? "" : "disabled"}>출근하기</button>
        <button class="dealer-action-btn danger" data-self-action="checked_out" ${canCheckOut ? "" : "disabled"}>퇴근하기</button>
      </div>
    </div>
  </section>
` : "";

  dealerOpsMount.innerHTML = `
    ${selfHtml}
    ${adminHtml}
  `;
}
async function loadDealerAttendanceOnce() {
  dealerAttendanceMap.clear();

  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!tournamentId || !user) return;

  try {
    if (getIsAdmin(user, currentUserProfile)) {
      const snap = await getDocs(collection(db, "dealer_attendance"));

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        dealerAttendanceMap.set(d.id, {
          uid: String(data.uid || "").trim(),
          nickname: String(data.nickname || "").trim(),
          email: String(data.email || "").trim(),
          tournamentId: String(data.tournamentId || "").trim(),
          status: String(data.status || "off").trim(),
          checkedInAt: Number(data.checkedInAt || 0) || null,
          checkedOutAt: Number(data.checkedOutAt || 0) || null,
          breakStartedAt: Number(data.breakStartedAt || 0) || null,
          totalBreakMs: Number(data.totalBreakMs || 0) || 0,
          currentEventId: String(data.currentEventId || "").trim(),
          currentBoxId: String(data.currentBoxId || "").trim(),
          currentSeatId: String(data.currentSeatId || "").trim(),
          currentSeatLabel: String(data.currentSeatLabel || "").trim(),
          updatedAt: Number(data.updatedAt || 0) || 0
        });
      });
    } else {
      const snap = await getDoc(getAttendanceRef(tournamentId, user.uid));

      if (snap.exists()) {
        const data = snap.data() || {};
        dealerAttendanceMap.set(snap.id, {
          uid: String(data.uid || "").trim(),
          nickname: String(data.nickname || "").trim(),
          email: String(data.email || "").trim(),
          tournamentId: String(data.tournamentId || "").trim(),
          status: String(data.status || "off").trim(),
          checkedInAt: Number(data.checkedInAt || 0) || null,
          checkedOutAt: Number(data.checkedOutAt || 0) || null,
          breakStartedAt: Number(data.breakStartedAt || 0) || null,
          totalBreakMs: Number(data.totalBreakMs || 0) || 0,
          currentEventId: String(data.currentEventId || "").trim(),
          currentBoxId: String(data.currentBoxId || "").trim(),
          currentSeatId: String(data.currentSeatId || "").trim(),
          currentSeatLabel: String(data.currentSeatLabel || "").trim(),
          updatedAt: Number(data.updatedAt || 0) || 0
        });
      }
    }

    scheduleRenderDealerOps();
  } catch (err) {
    console.error("loadDealerAttendanceOnce error:", err);
  }
}

async function ensureMyState() {
  const user = auth.currentUser;
  if (!user) return;

  const uid = String(user.uid || "").trim();
  if (!uid) return;

  const seatInfo = dealerSeatMap.get(uid);

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  let waitingList = [];
  if (snap.exists()) {
    const data = snap.data() || {};
    waitingList = Array.isArray(data.waiting) ? data.waiting : [];
  }

  const inWaiting = waitingList.some(
    (w) => String(w.uid || "").trim() === uid
  );

  // seat에도 없고 waiting에도 없으면 복구
  if (!seatInfo && !inWaiting) {
    const nickname =
      String(currentUserProfile?.nickname || user.displayName || "").trim() ||
      String(user.email || "").trim() ||
      "Dealer";

    waitingList.push({
      id: `auto_${uid}`,
      uid,
      email: String(user.email || "").trim(),
      name: nickname,
      addedAt: Date.now()
    });

    await setDoc(
      waitingRef,
      {
        waiting: waitingList,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  }
}

function normalizeAttendanceDoc(data = {}) {
  return {
    uid: String(data.uid || "").trim(),
    nickname: String(data.nickname || "").trim(),
    email: String(data.email || "").trim(),
    tournamentId: String(data.tournamentId || "").trim(),
    status: String(data.status || "off").trim(),
    checkedInAt: Number(data.checkedInAt || 0) || null,
    checkedOutAt: Number(data.checkedOutAt || 0) || null,
    breakStartedAt: Number(data.breakStartedAt || 0) || null,
    totalBreakMs: Number(data.totalBreakMs || 0) || 0,
    currentEventId: String(data.currentEventId || "").trim(),
    currentBoxId: String(data.currentBoxId || "").trim(),
    currentSeatId: String(data.currentSeatId || "").trim(),
    currentSeatLabel: String(data.currentSeatLabel || "").trim(),
    updatedAt: Number(data.updatedAt || 0) || 0
  };
}

function bindDealerAttendanceRealtime() {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!tournamentId || !user) return;

  if (stopDealerAttendanceWatch) {
    stopDealerAttendanceWatch();
    stopDealerAttendanceWatch = null;
  }

  if (getIsAdmin(user, currentUserProfile)) {
    stopDealerAttendanceWatch = onSnapshot(
      collection(db, "dealer_attendance"),
      (snap) => {
        dealerAttendanceMap.clear();

        snap.docs.forEach((d) => {
          const data = normalizeAttendanceDoc(d.data() || {});
          if (data.tournamentId !== tournamentId) return;
          dealerAttendanceMap.set(d.id, data);
        });

        renderDealerOps();
      },
      (err) => {
        console.error("bindDealerAttendanceRealtime(admin) error:", err);
      }
    );
    return;
  }

  stopDealerAttendanceWatch = onSnapshot(
    getAttendanceRef(tournamentId, user.uid),
    (snap) => {
      dealerAttendanceMap.delete(getAttendanceDocId(tournamentId, user.uid));

      if (snap.exists()) {
        const data = normalizeAttendanceDoc(snap.data() || {});
        dealerAttendanceMap.set(snap.id, data);
      }

      renderDealerOps();
    },
    (err) => {
      console.error("bindDealerAttendanceRealtime(user) error:", err);
    }
  );
}

function getMySeatInfo(uid) {
  return dealerSeatMap.get(uid) || null;
}

async function getSharedWaitingState() {
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  if (!snap.exists()) {
    return {
      ref: waitingRef,
      state: { version: 2, waiting: [], updatedAt: Date.now() }
    };
  }

  const data = snap.data() || {};
  return {
    ref: waitingRef,
    state: {
      ...data,
      version: 2,
      waiting: Array.isArray(data.waiting) ? data.waiting : [],
      updatedAt: Number(data.updatedAt || Date.now())
    }
  };
}

async function ensureMeRecovered(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return;

  const me = getDerivedAttendance(user);
  const seatInfo = getMySeatInfo(user.uid);

  const { ref: waitingRef, state: waitingStateDoc } = await getSharedWaitingState();
  const waitingList = Array.isArray(waitingStateDoc.waiting) ? waitingStateDoc.waiting : [];

  const inWaiting = waitingList.some((item) => {
    if (!item || typeof item !== "object") return false;
    return String(item.uid || "").trim() === String(user.uid).trim();
  });

  // assigned인데 실제 seat 없음 -> waiting 복구
  if (me?.status === "assigned" && !seatInfo) {
    const nickname =
      String(currentUserProfile?.nickname || user.displayName || "").trim() ||
      String(user.email || "").trim();

    await setDoc(
      getAttendanceRef(tournamentId, user.uid),
      {
        uid: user.uid,
        tournamentId,
        email: String(currentUserProfile?.email || user.email || "").trim(),
        nickname,
        status: "waiting",
        currentEventId: "",
        currentBoxId: "",
        currentSeatId: "",
        currentSeatLabel: "",
        updatedAt: Date.now()
      },
      { merge: true }
    );

    if (!inWaiting) {
      waitingList.push({
        id: `w_${user.uid}`,
        uid: user.uid,
        email: String(currentUserProfile?.email || user.email || "").trim(),
        name: nickname,
        addedAt: Date.now(),
        source: "auto_recover_assigned",
        tournamentId
      });

      await setDoc(
        waitingRef,
        {
          ...waitingStateDoc,
          version: 2,
          waiting: waitingList,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    }

    await loadDealerAttendanceOnce();
    renderDealerOps();
    return;
  }

  // waiting / checked_in인데 실제 waiting도 seat도 없음 -> waiting 재생성
  if ((me?.status === "waiting" || me?.status === "checked_in") && !inWaiting && !seatInfo) {
    await joinSharedWaitingOnCheckIn(user);
    await loadDealerAttendanceOnce();
    renderDealerOps();
  }
}

function getStatus(date, start, close) {
  const now = getNowInAppTime();
  const startTime = parseDateTime(date, start);
  const closeTime = parseDateTime(date, close);

  if (!startTime || !closeTime) return "scheduled";

  const openTime = new Date(startTime.getTime() - 30 * 60 * 1000);

  if (now < openTime) return "scheduled";
  if (now >= openTime && now < startTime) return "opened";
  if (now >= startTime && now < closeTime) return "running";
  return "closed";
}

function getStatusLabel(status) {
  if (status === "scheduled") return "SCHEDULED";
  if (status === "opened") return "OPENED";
  if (status === "running") return "RUNNING";
  if (status === "closed") return "CLOSED";
  return "SCHEDULED";
}

function normalizeEvents(docs) {
  return docs
    .map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        boxId: String(data.boxId || "").trim(),
        date: normalizeDateString(data.date || ""),
        title: String(data.title || d.id).trim(),
        start: String(data.start || "").trim(),
        close: String(data.close || "").trim()
      };
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.start.localeCompare(b.start);
    });
}

function groupByDate(list) {
  const grouped = new Map();
  for (const item of list) {
    if (!grouped.has(item.date)) {
      grouped.set(item.date, []);
    }
    grouped.get(item.date).push(item);
  }
  return [...grouped.entries()];
}

/* ===============================
   SEAT SUMMARY
=============================== */
function buildSeatSummaryMap(docs) {
  const next = new Map();

  docs.forEach((d) => {
    const data = d.data() || {};
    const eventId = String(data.eventId || "").trim();
    const boxId = String(data.boxId || "").trim();
    const seats = Array.isArray(data.seats) ? data.seats : [];

    if (!eventId || !boxId) return;

    const totalSeats = seats.length;
    const occupiedSeats = seats.filter((seat) => {
      const person = String(seat?.person || "").trim();
      return person && person !== "비어있음";
    }).length;

    next.set(`${eventId}__${boxId}`, {
      totalSeats,
      occupiedSeats,
      emptySeats: Math.max(0, totalSeats - occupiedSeats)
    });
  });

  return next;
}

function getSeatSummary(eventId, boxId) {
  return seatSummaryMap.get(`${eventId}__${boxId}`) || {
    totalSeats: 0,
    occupiedSeats: 0,
    emptySeats: 0
  };
}

function formatSeatSummary(eventId, boxId) {
  const summary = getSeatSummary(eventId, boxId);

  if (summary.totalSeats <= 0) return "No Seats";
  return `${summary.totalSeats} Seats · ${summary.occupiedSeats} In Use`;
}

/* ===============================
   FIRESTORE EVENT REFS
=============================== */
function getEventsCollectionRef() {
  const tournamentId = getTournamentId();
  return collection(db, "tournaments", tournamentId, "events");
}

function getEventDocRef(eventId) {
  const tournamentId = getTournamentId();
  return doc(db, "tournaments", tournamentId, "events", eventId);
}

/* ===============================
   MY SEAT ASSIGNMENT WATCH
=============================== */
function bindMySeatAssignment(user) {
  if (!user) return;

  if (stopMySeatNotificationWatch) {
    stopMySeatNotificationWatch();
    stopMySeatNotificationWatch = null;
  }

  const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";
  let seatModalAudioCtx = null;
  let seatModalAudioUnlocked = false;
  let seatModalAudioTimer = null;

  function stopSeatModalSoundLoop() {
    if (seatModalAudioTimer) {
      clearInterval(seatModalAudioTimer);
      seatModalAudioTimer = null;
    }
  }

  function hasSavedSoundPreference() {
    try {
      return localStorage.getItem(SOUND_ENABLED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function ensureSeatModalAudioContext() {
    if (seatModalAudioCtx) return seatModalAudioCtx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    seatModalAudioCtx = new AudioCtx();
    return seatModalAudioCtx;
  }

  async function unlockSeatModalAudio() {
    if (seatModalAudioUnlocked) return true;
    const ctx = ensureSeatModalAudioContext();
    if (!ctx) return false;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      seatModalAudioUnlocked = true;
      return true;
    } catch (err) {
      console.error("unlockSeatModalAudio error:", err);
      return false;
    }
  }

  function playSeatModalBeep() {
    const ctx = ensureSeatModalAudioContext();
    if (!ctx) return false;
    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.35, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      gain.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1046.5, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.36);
      return true;
    } catch (err) {
      console.error("playSeatModalBeep error:", err);
      return false;
    }
  }

  async function startSeatModalSoundLoop() {
    const ok = await unlockSeatModalAudio();
    if (!ok) return;
    playSeatModalBeep();
    if (!hasSavedSoundPreference()) return;
    stopSeatModalSoundLoop();
    seatModalAudioTimer = setInterval(() => {
      playSeatModalBeep();
    }, 1000);
  }

  ["click", "touchstart", "keydown"].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        void unlockSeatModalAudio();
      },
      { once: true }
    );
  });

  function hideSeatAssignmentModal() {
    const overlay = document.getElementById("seatAssignmentModal");
    overlay?.classList.remove("show");
    stopSeatModalSoundLoop();
  }

  function ensureSeatAssignmentModalUi() {
  let overlay = document.getElementById("seatAssignmentModal");

  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "seatAssignmentModal";
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="modal-card">
      <h2>배치 알림</h2>
      <p id="seatAssignmentMessage" style="line-height:1.6; margin:0 0 18px;"></p>
      <div class="modal-actions">
        <button id="seatAssignmentGoBtn" class="btn primary" type="button">이동</button>
        <button id="seatAssignmentOkBtn" class="btn ghost" type="button">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  return overlay;
}

async function showSeatAssignmentModal({ message = "", targetUrl = "", uid = "" }) {
  const overlay = ensureSeatAssignmentModalUi();
  const msg = document.getElementById("seatAssignmentMessage");
  const goBtn = document.getElementById("seatAssignmentGoBtn");
  const okBtn = document.getElementById("seatAssignmentOkBtn");

  if (msg) {
    msg.textContent = message || "Seat에 배치되었습니다.";
  }

  overlay.classList.add("show");
  void startSeatModalSoundLoop();

  const acknowledge = async () => {
    if (!uid) return;
    try {
      await setDoc(
        doc(db, "layout_notifications", uid),
        {
          acknowledged: true,
          acknowledgedAt: Date.now(),
          updatedAt: Date.now()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("ack seat notification error:", err);
    }
  };

  if (okBtn) {
    okBtn.onclick = async () => {
      hideSeatAssignmentModal();
      await acknowledge();
      render();
      refreshCardStatuses();
    };
  }

  if (goBtn) {
    goBtn.onclick = () => {
      hideSeatAssignmentModal();
      location.href = targetUrl || "./layout.html";
    };
  }
}

  const ref = doc(db, "layout_notifications", user.uid);

  stopMySeatNotificationWatch = onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        currentSeatAssignment = null;
        hideSeatAssignmentModal();
        render();
        refreshCardStatuses();
        return;
      }

      const data = snap.data() || {};
      if (data.type !== "seat_assigned") {
        currentSeatAssignment = null;
        hideSeatAssignmentModal();
        render();
        refreshCardStatuses();
        return;
      }

      currentSeatAssignment = {
        eventId: String(data.eventId || "").trim(),
        boxId: String(data.boxId || "").trim(),
        seatId: String(data.seatId || "").trim(),
        seatLabel: String(data.seatLabel || "").trim(),
        eventTitle: String(data.eventTitle || "").trim(),
        targetUrl: String(data.targetUrl || "").trim(),
        acknowledged: data.acknowledged === true
      };

      render();
      refreshCardStatuses();

      if (data.acknowledged !== true) {
        showSeatAssignmentModal({
          message:
            String(data.message || "").trim() ||
            `${String(data.eventTitle || "").trim()} / Seat ${String(data.seatLabel || "").trim()}에 배치되었습니다.`,
          targetUrl: String(data.targetUrl || "").trim(),
          uid: user.uid
        });
      } else {
        hideSeatAssignmentModal();
      }
    },
    (err) => {
      console.error("bindMySeatAssignment error:", err);
    }
  );
}

/* ===============================
   RENDER
=============================== */
function render() {
  if (!root) return;

  root.innerHTML = "";

  if (!events.length) {
    root.innerHTML = `
      <div class="date-header">
        <div class="date-title">No events</div>
        <div class="date-count">0 events</div>
      </div>
    `;
    return;
  }

  const groups = groupByDate(events);

  groups.forEach(([date, list]) => {
    const header = document.createElement("section");
    header.className = "date-header";
    header.innerHTML = `
      <div class="date-title">${escapeHtml(formatDateTitle(date))}</div>
      <div class="date-count">${list.length} events</div>
    `;
    root.appendChild(header);

    list.forEach((e) => {
      const status = getStatus(e.date, e.start, e.close);
      const seatSummaryText = formatSeatSummary(e.id, e.boxId);

      const assignedHere =
        currentSeatAssignment &&
        currentSeatAssignment.eventId === e.id &&
        currentSeatAssignment.boxId === e.boxId;

      const assignmentBadge = assignedHere
        ? `<div class="my-seat-badge">내 배치됨 · Seat ${escapeHtml(currentSeatAssignment.seatLabel || "")}</div>`
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

      root.appendChild(card);
    });
  });
}

function refreshCardStatuses() {
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

/* ===============================
   ADMIN MODAL HELPERS
=============================== */
function resetEventForm() {
  eventCardId.value = "";
  eventCardBoxId.value = "";
  eventCardDate.value = "";
  eventCardTitle.value = "";
  eventCardStart.value = "";
  eventCardClose.value = "";
}

function makeNextEventDefaults() {
  const nextNo = events.length + 1;
  const tournamentId = getTournamentId();
  const now = getNowInAppTime();

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  eventCardId.value = `event_${nextNo}`;
  eventCardBoxId.value = `box_${nextNo}`;
  eventCardDate.value = `${yyyy}-${mm}-${dd}`;
  eventCardTitle.value = `${tournamentId || "Event"} ${nextNo}`;
  eventCardStart.value = "21:00";
  eventCardClose.value = "21:30";
}

function syncSelectedEventForm() {
  const selected = events.find((e) => e.id === eventCardSelect.value);

  if (!selected) {
    resetEventForm();
    return;
  }

  eventCardId.value = selected.id || "";
  eventCardBoxId.value = selected.boxId || "";
  eventCardDate.value = selected.date || "";
  eventCardTitle.value = selected.title || "";
  eventCardStart.value = selected.start || "";
  eventCardClose.value = selected.close || "";
}

function populateEventSelect(preferredId = "") {
  if (!eventCardSelect) return;

  if (!events.length) {
    eventCardSelect.innerHTML = `<option value="">카드 없음</option>`;
    resetEventForm();
    return;
  }

  eventCardSelect.innerHTML = events.map((e) => `
    <option value="${escapeHtml(e.id)}">${escapeHtml(e.title)} (${escapeHtml(e.start)})</option>
  `).join("");

  const targetId = preferredId && events.some((e) => e.id === preferredId)
    ? preferredId
    : events[0].id;

  eventCardSelect.value = targetId;
  syncSelectedEventForm();
}

function renderEventAdminList() {
  if (!eventCardList) return;

  if (!events.length) {
    eventCardList.innerHTML = `<div class="empty-list">카드가 없습니다.</div>`;
    return;
  }

  eventCardList.innerHTML = events.map((e) => `
    <div class="event-admin-row" data-id="${escapeHtml(e.id)}">
      <div class="event-admin-main">
        <div class="event-admin-name">${escapeHtml(e.title)}</div>
        <div class="event-admin-meta">
          ${escapeHtml(e.date)} · ${escapeHtml(e.start)} ~ ${escapeHtml(e.close)} · ${escapeHtml(e.boxId)}
        </div>
      </div>
      <button class="event-admin-pick" type="button" data-pick-id="${escapeHtml(e.id)}">선택</button>
    </div>
  `).join("");
}

/* ===============================
   LOAD / WATCH EVENTS
=============================== */
async function loadEvents() {
  const snap = await getDocs(getEventsCollectionRef());
  events = normalizeEvents(snap.docs);
}

function bindEventsRealtime() {
  if (stopEventsWatch) {
    stopEventsWatch();
    stopEventsWatch = null;
  }

  stopEventsWatch = onSnapshot(
    getEventsCollectionRef(),
    (snap) => {
      events = normalizeEvents(snap.docs);
      render();
      refreshCardStatuses();

      if (eventCardSelect && eventAdminModal?.classList.contains("show")) {
        const selectedId = eventCardId?.value?.trim() || eventCardSelect.value || "";
        populateEventSelect(selectedId);
        renderEventAdminList();
      }
    },
    (err) => {
      console.error("bindEventsRealtime error:", err);
    }
  );
}

function bindLayoutSeatSummaryRealtime() {
  if (stopLayoutEventsWatch) {
    stopLayoutEventsWatch();
    stopLayoutEventsWatch = null;
  }

  stopLayoutEventsWatch = onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      seatSummaryMap = buildSeatSummaryMap(snap.docs);
      render();
      refreshCardStatuses();
    },
    (err) => {
      console.error("bindLayoutSeatSummaryRealtime error:", err);
    }
  );
}

function bindDealerSeatRealtime() {
  if (stopDealerSeatWatch) {
    stopDealerSeatWatch();
    stopDealerSeatWatch = null;
  }

  stopDealerSeatWatch = onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      dealerSeatMap.clear();

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const eventId = String(data.eventId || "").trim();
        const boxId = String(data.boxId || "").trim();
        const seats = Array.isArray(data.seats) ? data.seats : [];

        seats.forEach((seat) => {
          const uid = String(seat?.personUid || "").trim();
          if (!uid) return;

          dealerSeatMap.set(uid, {
            eventId,
            boxId,
            seatId: String(seat?.id || "").trim(),
            seatLabel: String(seat?.label ?? seat?.no ?? "")
          });
        });
      });

      void ensureMeRecovered(auth.currentUser);
      renderDealerOps();
    },
    (err) => {
      console.error("bindDealerSeatRealtime error:", err);
    }
  );
}

/* ===============================
   SAVE / DELETE EVENT CARD
=============================== */
async function saveEventCard() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!getIsAdmin(auth.currentUser, currentUserProfile)) return;

  const id = eventCardId.value.trim();

  if (!id) {
    alert("카드 ID를 입력하세요.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("카드 ID에는 '/' 문자를 사용할 수 없습니다.");
    return;
  }

  const boxId = eventCardBoxId.value.trim();
  if (!boxId || !isValidDocId(boxId)) {
    alert("유효한 Box ID를 입력하세요. '/' 문자는 사용할 수 없습니다.");
    return;
  }

  try {
    await setDoc(
      getEventDocRef(id),
      {
        boxId,
        date: normalizeDateString(eventCardDate.value.trim()),
        title: eventCardTitle.value.trim(),
        start: eventCardStart.value.trim(),
        close: eventCardClose.value.trim()
      },
      { merge: true }
    );

    alert("카드가 저장되었습니다.");
  } catch (err) {
    console.error(err);
    alert("카드 저장에 실패했습니다.");
  }
}

async function getLayoutEventDocByEventAndBox(eventId, boxId) {
  const snap = await getDocs(collection(db, "layout_events"));

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const sameEvent = String(data.eventId || "").trim() === String(eventId || "").trim();
    const sameBox = String(data.boxId || "").trim() === String(boxId || "").trim();

    if (sameEvent && sameBox) {
      return {
        ref: docSnap.ref,
        id: docSnap.id,
        data
      };
    }
  }

  return null;
}

async function removeUsersFromSharedWaitingByUids(targetUids = []) {
  const uidSet = new Set(
    (Array.isArray(targetUids) ? targetUids : [])
      .map((uid) => String(uid || "").trim())
      .filter(Boolean)
  );

  if (!uidSet.size) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  if (!snap.exists()) return;

  const data = snap.data() || {};
  const waiting = Array.isArray(data.waiting) ? data.waiting : [];

  const nextWaiting = waiting.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const uid = String(item.uid || "").trim();
    return !uidSet.has(uid);
  });

  if (nextWaiting.length === waiting.length) return;

  await setDoc(
    waitingRef,
    {
      ...data,
      version: 2,
      waiting: nextWaiting,
      updatedAt: Date.now()
    },
    { merge: true }
  );
}

async function forceCheckOutUsersForDeletedEvent({ eventId = "", boxId = "" }) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return { affectedUsers: [] };
  if (!getIsAdmin(auth.currentUser, currentUserProfile)) return { affectedUsers: [] };

  const layoutDoc = await getLayoutEventDocByEventAndBox(eventId, boxId);
  if (!layoutDoc) return { affectedUsers: [] };

  const data = layoutDoc.data || {};
  const seats = Array.isArray(data.seats) ? data.seats : [];

  const affectedUsers = seats
    .filter((seat) => seat && typeof seat === "object")
    .map((seat) => ({
      uid: String(seat.personUid || "").trim(),
      nickname: String(seat.person || "").trim(),
      email: String(seat.personEmail || "").trim(),
      seatId: String(seat.id || "").trim(),
      seatLabel: String(seat.label ?? seat.no ?? "").trim()
    }))
    .filter((user) => user.uid);

  const now = Date.now();

  // 핵심 상태 변경(출퇴근/알림)은 배치 커밋으로 묶어 부분 실패 전파를 줄인다.
  for (const usersChunk of chunkArray(affectedUsers, 200)) {
    const batch = writeBatch(db);

    usersChunk.forEach((user) => {
      batch.set(
        getAttendanceRef(tournamentId, user.uid),
        {
          uid: user.uid,
          tournamentId,
          nickname: user.nickname,
          email: user.email,
          status: "checked_out",
          checkedOutAt: now,
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: "",
          updatedAt: now
        },
        { merge: true }
      );

      batch.set(
        doc(db, "layout_notifications", user.uid),
        {
          type: "event_deleted",
          acknowledged: true,
          seatId: "",
          seatLabel: "",
          eventId: "",
          eventTitle: "",
          boxId: "",
          targetUrl: "",
          message: "",
          updatedAt: now
        },
        { merge: true }
      );
    });

    await commitBatchWithRetry(batch, { maxRetries: 1, retryDelayMs: 250 });
  }

  // 운영 로그는 부가 정보이므로 best-effort로 기록(개별 실패가 전체 롤백을 유발하지 않음)
  await Promise.allSettled(
    affectedUsers.map((user) => writeAttendanceLog({
      uid: user.uid,
      nickname: user.nickname,
      action: "checked_out",
      tournamentId,
      eventId,
      boxId,
      seatId: user.seatId,
      seatLabel: user.seatLabel
    }))
  );

  await removeUsersFromSharedWaitingByUids(affectedUsers.map((u) => u.uid));

  await setDoc(
    layoutDoc.ref,
    {
      ...data,
      seats: seats.map((seat) => ({
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      })),
      updatedAt: now
    },
    { merge: true }
  );

  return { affectedUsers };
}

async function deleteEventCardCurrent() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!getIsAdmin(auth.currentUser, currentUserProfile)) return;

  const id = eventCardId.value.trim();

  if (!id) {
    alert("삭제할 카드가 없습니다.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("유효하지 않은 카드 ID입니다.");
    return;
  }

  const boxId = eventCardBoxId.value.trim();

  const ok = confirm(`"${id}" 카드를 삭제할까요?\n배치 중인 딜러는 강제 퇴근 처리됩니다.`);
  if (!ok) return;

  try {
    const { affectedUsers } = await forceCheckOutUsersForDeletedEvent({
      eventId: id,
      boxId
    });

    await deleteDoc(getEventDocRef(id));

    alert(
      affectedUsers.length
        ? `카드가 삭제되었습니다.\n배치 중이던 ${affectedUsers.length}명은 강제 퇴근 처리되었습니다.`
        : "카드가 삭제되었습니다."
    );
  } catch (err) {
    console.error(err);
    alert("카드 삭제에 실패했습니다.");
  }
}

/* ===============================
   TOURNAMENT PERIOD GUARD
=============================== */
function routeToHub(message) {
  if (periodBlocked) return;
  periodBlocked = true;

  if (message) alert(message);
  location.replace("./hub.html");
}

async function initTournamentPeriodWatch() {
  const tournamentId = getTournamentId();

  if (!tournamentId) {
    if (topbarTournamentName) {
      topbarTournamentName.textContent = "Tournament Events";
    }
    return;
  }

  sessionStorage.setItem("tournamentId", tournamentId);

  const tournamentRef = doc(db, "tournaments", tournamentId);

  try {
    const snap = await getDoc(tournamentRef);

    if (!snap.exists()) {
      if (topbarTournamentName) {
        topbarTournamentName.textContent = "Tournament Events";
      }
      return;
    }

    currentTournament = {
      id: snap.id,
      ...(snap.data() || {})
    };

    if (topbarTournamentName) {
      topbarTournamentName.textContent = currentTournament.name || "Tournament Events";
    }

    if (!isTournamentActive(currentTournament)) {
      routeToHub("대회 기간이 아니거나 종료되어 허브로 이동합니다.");
      return;
    }

    stopTournamentWatch = onSnapshot(
      tournamentRef,
      (docSnap) => {
        if (!docSnap.exists()) {
          routeToHub("대회 정보가 없어 허브로 이동합니다.");
          return;
        }

        currentTournament = {
          id: docSnap.id,
          ...(docSnap.data() || {})
        };

        if (topbarTournamentName) {
          topbarTournamentName.textContent = currentTournament.name || "Tournament Events";
        }

        if (!isTournamentActive(currentTournament)) {
          routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
        }
      },
      (error) => {
        console.error("❌ tournament watch error:", error);
      }
    );
  } catch (error) {
    console.error("❌ initTournamentPeriodWatch error:", error);
  }
}

/* ===============================
   SHARED WAITING
=============================== */
async function isUserAlreadySeated(userUid) {
  if (!userUid) return false;

  try {
    const snap = await getDocs(collection(db, "layout_events"));

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const seats = Array.isArray(data.seats) ? data.seats : [];

      const found = seats.some((seat) => {
        if (!seat || typeof seat !== "object") return false;
        return String(seat.personUid || "").trim() === String(userUid).trim();
      });

      if (found) return true;
    }

    return false;
  } catch (err) {
    console.error("❌ isUserAlreadySeated error:", err);
    return false;
  }
}

async function joinSharedWaitingOnCheckIn(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) return false;

    const userProfile = userSnap.data() || {};
    currentUserProfile = userProfile;

    if (getIsAdmin(user, userProfile)) return false;

    const nickname = String(userProfile.nickname || "").trim();
    const email = String(userProfile.email || user.email || "").trim();
    if (!nickname) {
      alert("닉네임이 없어서 출근할 수 없습니다. 프로필에서 닉네임을 확인해주세요.");
      return false;
    }

    const alreadySeated = await isUserAlreadySeated(user.uid);
    if (alreadySeated) return true;

    const waitingRef = doc(db, "layout_shared", "global_waiting");

    await runTransaction(db, async (tx) => {
      const waitingSnap = await tx.get(waitingRef);
      const waitingState = waitingSnap.exists()
        ? (waitingSnap.data() || {})
        : { version: 2, waiting: [], updatedAt: Date.now() };

      const waitingList = Array.isArray(waitingState.waiting)
        ? [...waitingState.waiting]
        : [];

      const alreadyInWaiting = waitingList.some((item) => {
        if (!item || typeof item !== "object") return false;
        return String(item.uid || "").trim() === String(user.uid).trim();
      });

      if (alreadyInWaiting) return;

      waitingList.push({
        id: `w_${user.uid}`,
        uid: user.uid,
        email,
        name: nickname,
        addedAt: Date.now(),
        source: "checkin",
        tournamentId
      });

      tx.set(
        waitingRef,
        {
          ...waitingState,
          version: 2,
          waiting: waitingList,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    });

    return true;
  } catch (error) {
    console.error("❌ joinSharedWaitingOnCheckIn error:", error);
    alert("출근 처리 중 오류가 발생했습니다.");
    return false;
  }
}

async function removeFromSharedWaitingOnCheckOut(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  try {
    const waitingRef = doc(db, "layout_shared", "global_waiting");

    await runTransaction(db, async (tx) => {
      const waitingSnap = await tx.get(waitingRef);
      if (!waitingSnap.exists()) return;

      const waitingState = waitingSnap.data() || {};
      const waitingList = Array.isArray(waitingState.waiting)
        ? waitingState.waiting
        : [];

      const nextWaiting = waitingList.filter((item) => {
        if (!item || typeof item !== "object") return false;

        const itemUid = String(item.uid || "").trim();
        const itemTournamentId = String(item.tournamentId || "").trim();

        if (itemUid !== String(user.uid || "").trim()) return true;
        if (itemTournamentId && itemTournamentId !== tournamentId) return true;

        return false;
      });

      tx.set(
        waitingRef,
        {
          ...waitingState,
          version: 2,
          waiting: nextWaiting,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    });

    return true;
  } catch (error) {
    console.error("❌ removeFromSharedWaitingOnCheckOut error:", error);
    alert("퇴근 처리 중 오류가 발생했습니다.");
    return false;
  }
}

async function removeUserFromAllSeatsGlobal(user) {
  if (!user?.uid) return 0;

  try {
    const snap = await getDocs(collection(db, "layout_events"));
    let removedCount = 0;

    await Promise.all(
      snap.docs.map(async (docSnap) => {
        const data = docSnap.data() || {};
        const seats = Array.isArray(data.seats) ? data.seats : [];
        let changed = false;

        const nextSeats = seats.map((seat) => {
          if (!seat || typeof seat !== "object") return seat;

          const personUid = String(seat.personUid || "").trim();
          if (personUid !== String(user.uid).trim()) return seat;

          changed = true;
          removedCount += 1;

          return {
            ...seat,
            person: "비어있음",
            personUid: "",
            personEmail: "",
            seatedAt: null
          };
        });

        if (!changed) return;

        await setDoc(
          docSnap.ref,
          {
            ...data,
            seats: nextSeats,
            updatedAt: Date.now()
          },
          { merge: true }
        );
      })
    );

    return removedCount;
  } catch (error) {
    console.error("❌ removeUserFromAllSeatsGlobal error:", error);
    return 0;
  }
}

async function clearUserSeatNotification(uid) {
  if (!uid) return;

  try {
    await setDoc(
      doc(db, "layout_notifications", uid),
      {
        type: "seat_cleared",
        acknowledged: true,
        seatId: "",
        seatLabel: "",
        eventId: "",
        eventTitle: "",
        boxId: "",
        targetUrl: "",
        message: "",
        updatedAt: Date.now()
      },
      { merge: true }
    );
  } catch (error) {
    console.error("❌ clearUserSeatNotification error:", error);
  }
}

async function forceAdminCheckedOut(target) {
  if (!target?.uid) return;

  await removeUserFromAllSeatsGlobal({ uid: target.uid });
  await removeFromSharedWaitingOnCheckOut({
    uid: target.uid,
    email: target.email || "",
    displayName: target.nickname || "",
    nickname: target.nickname || ""
  });
  await updateAdminAttendanceStatus(target.uid, "checked_out");
  await setDoc(
    getAttendanceRef(getTournamentId(), target.uid),
    {
      currentEventId: "",
      currentBoxId: "",
      currentSeatId: "",
      currentSeatLabel: "",
      updatedAt: Date.now()
    },
    { merge: true }
  );
  await clearUserSeatNotification(target.uid);
}

async function forceSelfCheckedOut(user) {
  if (!user?.uid) return;

  const targetProfile = currentUserProfile || {};

  await removeUserFromAllSeatsGlobal({ uid: user.uid });
  await removeFromSharedWaitingOnCheckOut({
    uid: user.uid,
    email: String(targetProfile.email || user.email || "").trim(),
    displayName: String(targetProfile.nickname || user.displayName || "").trim(),
    nickname: String(targetProfile.nickname || user.displayName || "").trim()
  });

  await updateMyAttendanceStatus("checked_out");

  await setDoc(
    getAttendanceRef(getTournamentId(), user.uid),
    {
      currentEventId: "",
      currentBoxId: "",
      currentSeatId: "",
      currentSeatLabel: "",
      updatedAt: Date.now()
    },
    { merge: true }
  );

  await clearUserSeatNotification(user.uid);
}

/* ===============================
   CLICK → LAYOUT
=============================== */
root?.addEventListener("click", (e) => {
  const card = e.target.closest(".event-card");
  if (!card) return;

  if (currentTournament && !isTournamentActive(currentTournament)) {
    routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
    return;
  }

  const tournamentId = getTournamentId();
  const eventId = card.dataset.eventId;
  const boxId = card.dataset.boxId;

  if (!eventId || !boxId) {
    console.warn("❌ Missing eventId or boxId");
    return;
  }

  sessionStorage.setItem("tournamentId", tournamentId);
  sessionStorage.setItem("eventId", eventId);
  sessionStorage.setItem("boxId", boxId);

  location.href = `layout.html?tournamentId=${encodeURIComponent(tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}`;
});

/* ===============================
   BACK
=============================== */
backBtn?.addEventListener("click", () => {
  sessionStorage.removeItem("boxId");
  location.href = "./hub.html";
});

/* ===============================
   EVENT ADMIN MODAL
=============================== */
eventAdminBtn?.addEventListener("click", async () => {
  await loadEvents();
  populateEventSelect();
  renderEventAdminList();
  openModal(eventAdminModal);
});

closeEventAdminBtn?.addEventListener("click", () => {
  closeModal(eventAdminModal);
});

eventAdminModal?.addEventListener("click", (e) => {
  if (e.target === eventAdminModal) {
    closeModal(eventAdminModal);
  }
});

eventCardSelect?.addEventListener("change", syncSelectedEventForm);

newEventCardBtn?.addEventListener("click", () => {
  resetEventForm();
  makeNextEventDefaults();
});

saveEventCardBtn?.addEventListener("click", saveEventCard);
deleteEventCardBtn?.addEventListener("click", deleteEventCardCurrent);

eventCardList?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-pick-id]");
  if (!btn) return;

  eventCardSelect.value = btn.dataset.pickId;
  syncSelectedEventForm();
});

dealerOpsMount?.addEventListener("input", (e) => {
  const searchEl = e.target.closest("[data-dealer-search]");
  if (!searchEl) return;

  dealerAdminUi.search = String(searchEl.value || "");
  renderDealerOps();
});

dealerOpsMount?.addEventListener("change", (e) => {
  const filterEl = e.target.closest("[data-dealer-filter]");
  if (filterEl) {
    dealerAdminUi.status = String(filterEl.value || "all");
    renderDealerOps();
    return;
  }

  const sortEl = e.target.closest("[data-dealer-sort]");
  if (sortEl) {
    dealerAdminUi.sort = String(sortEl.value || "name");
    renderDealerOps();
  }
});

dealerOpsMount?.addEventListener("click", async (e) => {
  try {
    const toggleBtn = e.target.closest("[data-dealer-toggle]");
    if (toggleBtn) {
      dealerUiCollapsed = !dealerUiCollapsed;
      renderDealerOps();
      return;
    }

    const user = auth.currentUser;
    const isAdmin = getIsAdmin(user, currentUserProfile);

    // =========================
    // ADMIN ACTION
    // =========================
    if (isAdmin) {
      const adminBtn = e.target.closest("[data-admin-action]");
      if (adminBtn) {
        const action = String(adminBtn.getAttribute("data-admin-action") || "").trim();
        const uid = String(adminBtn.getAttribute("data-admin-uid") || "").trim();

        if (!action || !uid) return;

        if (action === "checked_out") {
  const target = getAdminAttendanceList().find((item) => String(item.uid || "").trim() === uid);
  if (!target) return;

  await forceAdminCheckedOut(target);
  await loadDealerAttendanceOnce();
  renderDealerOps();
  return;
}
      }

      return;
    }

    // =========================
    // USER SELF ACTION
    // =========================
    const selfBtn = e.target.closest("[data-self-action]");
    if (!selfBtn || !user) return;

    const action = String(selfBtn.getAttribute("data-self-action") || "").trim();
    if (!action) return;

     if (action === "waiting") {
  const ok = await joinSharedWaitingOnCheckIn(user);
  if (!ok) return;

  await updateMyAttendanceStatus("waiting");
  await loadDealerAttendanceOnce();
  renderDealerOps();
  return;
}

if (action === "checked_out") {
  const removed = await removeFromSharedWaitingOnCheckOut(user);
  if (removed === false) return;

  await forceSelfCheckedOut(user);
  await loadDealerAttendanceOnce();
  renderDealerOps();
  return;
}
  } catch (err) {
    console.error("dealerOps click error:", err);
  }
});


/* ===============================
   INIT
=============================== */
async function init() {
  await loadEvents();

  bindEventsRealtime();
  bindLayoutSeatSummaryRealtime();

  await loadDealerAttendanceOnce();
  bindDealerAttendanceRealtime();
  bindDealerSeatRealtime();

  await ensureMeRecovered(auth.currentUser);

  render();
  renderDealerOps();
  refreshCardStatuses();

  setupAttendanceLogEvents();
  bindAttendanceLogsRealtime();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (stopMySeatNotificationWatch) {
      stopMySeatNotificationWatch();
      stopMySeatNotificationWatch = null;
    }
    location.replace("./login.html");
    return;
  }

  bindMySeatAssignment(user);

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    currentUserProfile = userSnap.exists() ? (userSnap.data() || {}) : null;

    if (!currentUserProfile) {
      currentUserProfile = {
        email: user.email || "",
        nickname: user.displayName || "",
        role: isAdminEmail(user.email || "") ? "admin" : "user",
        accessCode: "",
        allowedEvents: {}
      };
      await setDoc(userRef, currentUserProfile, { merge: true });
    }

    const isAdmin = getIsAdmin(auth.currentUser, currentUserProfile);

    console.log("[INDEX AUTH]", {
      uid: user.uid,
      email: user.email || "",
      profile: currentUserProfile,
      isAdmin
    });

    renderDealerOps();

    if (isAdmin) {
      eventAdminBtn?.classList.remove("hidden");
      attendanceLogBtn?.classList.remove("hidden");
      seatMapEditBtn?.classList.remove("hidden");
    } else {
      eventAdminBtn?.classList.add("hidden");
      attendanceLogBtn?.classList.add("hidden");
      seatMapEditBtn?.classList.add("hidden");
    }

    await initTournamentPeriodWatch();
    await init();
  } catch (err) {
    console.error("index auth init error:", err);
    alert("인덱스 데이터를 불러오지 못했습니다.");
  }
});

setInterval(() => {
  refreshCardStatuses();
}, 1000);

setInterval(() => {
  if (currentTournament && !isTournamentActive(currentTournament)) {
    routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
  }
}, 60000);

window.addEventListener("beforeunload", () => {
  if (stopTournamentWatch) stopTournamentWatch();
  if (stopMySeatNotificationWatch) stopMySeatNotificationWatch();
  if (stopEventsWatch) stopEventsWatch();
  if (stopLayoutEventsWatch) stopLayoutEventsWatch();
  if (stopDealerAttendanceWatch) stopDealerAttendanceWatch();
if (stopDealerSeatWatch) stopDealerSeatWatch();
});


/* ===============================
   SEAT MAP (ADD ONLY)
=============================== */

const seatMapBtn = document.getElementById("seatMapBtn");
const seatMapModal = document.getElementById("seatMapModal");
const seatMapCloseBtn = document.getElementById("seatMapCloseBtn");
const seatMapCanvas = document.getElementById("seatMapCanvas");
const seatMapScroll = document.getElementById("seatMapScroll");

let seatMapLayout = [];
let seatMapData = new Map();

const MAP_BASE_WIDTH = 1400;
const MAP_BASE_HEIGHT = 900;
const MAP_SEAT_SIZE = 48;
const MAP_PADDING = 120;

/* ===============================
   MAP SIZE HELPERS
=============================== */

function getSeatMapBounds(seats = []) {
  if (!Array.isArray(seats) || seats.length === 0) {
    return {
      width: MAP_BASE_WIDTH,
      height: MAP_BASE_HEIGHT
    };
  }

  let maxX = 0;
  let maxY = 0;

  seats.forEach((seat) => {
    const x = Number(seat?.x || 0);
    const y = Number(seat?.y || 0);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  return {
    width: Math.max(MAP_BASE_WIDTH, Math.ceil(maxX + MAP_SEAT_SIZE + MAP_PADDING)),
    height: Math.max(MAP_BASE_HEIGHT, Math.ceil(maxY + MAP_SEAT_SIZE + MAP_PADDING))
  };
}

function applySeatMapCanvasSize(canvasEl, seats = []) {
  if (!canvasEl) return;

  const bounds = getSeatMapBounds(seats);
  canvasEl.style.width = `${bounds.width}px`;
  canvasEl.style.height = `${bounds.height}px`;
}

function centerSeatMapViewport(scrollEl, canvasEl) {
  if (!scrollEl || !canvasEl) return;

  const maxLeft = Math.max(0, canvasEl.scrollWidth - scrollEl.clientWidth);
  const maxTop = Math.max(0, canvasEl.scrollHeight - scrollEl.clientHeight);

  scrollEl.scrollLeft = Math.min(maxLeft, Math.max(0, (canvasEl.scrollWidth - scrollEl.clientWidth) / 2));
  scrollEl.scrollTop = Math.min(maxTop, Math.max(0, (canvasEl.scrollHeight - scrollEl.clientHeight) / 2));
}

/* ===============================
   LOAD MAP LAYOUT
=============================== */

async function loadSeatMapLayout() {
  try {
    const snap = await getDoc(doc(db, "layout_shared", "floor_map"));

    if (!snap.exists()) {
      seatMapLayout = [];
      applySeatMapCanvasSize(seatMapCanvas, []);
      return;
    }

    const data = snap.data() || {};
    seatMapLayout = Array.isArray(data.seats) ? data.seats : [];
    applySeatMapCanvasSize(seatMapCanvas, seatMapLayout);
  } catch (err) {
    console.error("loadSeatMapLayout error", err);
  }
}

/* ===============================
   RENDER MAP
=============================== */

function renderSeatMap() {
  if (!seatMapCanvas) return;

  seatMapCanvas.innerHTML = "";
  applySeatMapCanvasSize(seatMapCanvas, seatMapLayout);

  seatMapLayout.forEach((seat) => {
    const seatId = String(seat.id || "");
    const x = Number(seat.x || 0);
    const y = Number(seat.y || 0);

    const info = seatMapData.get(seatId);

    const el = document.createElement("div");
    el.className = "map-seat";

    if (info) {
      el.classList.add("filled");
    }

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.innerText = seat.label || seatId;

    seatMapCanvas.appendChild(el);
  });
}

/* ===============================
   WATCH SEAT DATA
=============================== */

function bindSeatMapRealtime() {
  onSnapshot(collection(db, "layout_events"), (snap) => {
    seatMapData.clear();

    snap.docs.forEach((d) => {
      const data = d.data() || {};
      const seats = Array.isArray(data.seats) ? data.seats : [];

      seats.forEach((seat) => {
        const id = String(seat.id || seat.label || "");
        if (!id) return;

        seatMapData.set(id, {
          eventId: data.eventId,
          person: seat.person
        });
      });
    });

    renderSeatMap();
  });
}

/* ===============================
   DRAG MAP EDIT (ADMIN)
=============================== */

function enableSeatDrag() {
  if (!seatMapCanvas) return;

  let target = null;
  let offsetX = 0;
  let offsetY = 0;

  seatMapCanvas.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".map-seat");
    if (!el) return;

    target = el;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!target) return;

    const rect = seatMapCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left - offsetX;
    const y = e.clientY - rect.top - offsetY;

    target.style.left = `${x}px`;
    target.style.top = `${y}px`;
  });

  window.addEventListener("mouseup", () => {
    target = null;
  });
}

/* ===============================
   BUTTON EVENTS
=============================== */

seatMapBtn?.addEventListener("click", async () => {
  await loadSeatMapLayout();
  renderSeatMap();
  openModal(seatMapModal);

  requestAnimationFrame(() => {
    centerSeatMapViewport(seatMapScroll, seatMapCanvas);
  });
});

seatMapCloseBtn?.addEventListener("click", () => {
  closeModal(seatMapModal);
});

/* ===============================
   INIT SEAT MAP
=============================== */

bindSeatMapRealtime();
enableSeatDrag();

/* ===============================
   MAP EDITOR
=============================== */

const seatMapEditorModal = document.getElementById("seatMapEditorModal");
const seatMapEditorCloseBtn = document.getElementById("seatMapEditorCloseBtn");
const seatMapEditorCanvas = document.getElementById("seatMapEditorCanvas");
const seatMapEditorScroll = document.getElementById("seatMapEditorScroll");

const addSeatBtn = document.getElementById("addSeatBtn");
const saveMapBtn = document.getElementById("saveMapBtn");

let editorSeats = [];

/* load map */

async function loadMapEditor() {
  const snap = await getDoc(doc(db, "layout_shared", "floor_map"));

  if (!snap.exists()) {
    editorSeats = [];
  } else {
    const data = snap.data() || {};
    editorSeats = Array.isArray(data.seats) ? data.seats : [];
  }

  renderEditor();
}

/* render */

function renderEditor() {
  if (!seatMapEditorCanvas) return;

  seatMapEditorCanvas.innerHTML = "";
  applySeatMapCanvasSize(seatMapEditorCanvas, editorSeats);

  editorSeats.forEach((seat) => {
    const el = document.createElement("div");
    el.className = "map-seat";

    el.innerText = seat.label;
    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;

    enableDrag(el, seat);
    seatMapEditorCanvas.appendChild(el);
  });
}

/* drag */

function enableDrag(el, seat) {
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;

  el.addEventListener("mousedown", (e) => {
    dragging = true;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;

    const rect = seatMapEditorCanvas.getBoundingClientRect();

    seat.x = e.clientX - rect.left - offsetX;
    seat.y = e.clientY - rect.top - offsetY;

    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    applySeatMapCanvasSize(seatMapEditorCanvas, editorSeats);
  });
}

/* add seat */

addSeatBtn?.addEventListener("click", () => {
  const id = String(editorSeats.length + 1);

  editorSeats.push({
    id,
    label: id,
    x: 100,
    y: 100
  });

  renderEditor();

  requestAnimationFrame(() => {
    if (!seatMapEditorScroll || !seatMapEditorCanvas) return;
    seatMapEditorScroll.scrollLeft = Math.max(0, editorSeats[editorSeats.length - 1].x - 120);
    seatMapEditorScroll.scrollTop = Math.max(0, editorSeats[editorSeats.length - 1].y - 120);
  });
});

/* save */

saveMapBtn?.addEventListener("click", async () => {
  await setDoc(
    doc(db, "layout_shared", "floor_map"),
    { seats: editorSeats },
    { merge: true }
  );

  alert("맵 저장 완료");
});

/* open editor */

seatMapEditBtn?.addEventListener("click", async () => {
  await loadMapEditor();
  openModal(seatMapEditorModal);

  requestAnimationFrame(() => {
    centerSeatMapViewport(seatMapEditorScroll, seatMapEditorCanvas);
  });
});

/* close */

seatMapEditorCloseBtn?.addEventListener("click", () => {
  closeModal(seatMapEditorModal);
});

