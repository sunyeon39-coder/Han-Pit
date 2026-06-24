import { auth, db } from "../firebase.js";
import {
  collection,
  doc,
  deleteDoc,
  getDocs,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import {
  attendanceLogCreatedAtMs,
  writeAttendanceLog
} from "../shared/attendance-log-write.js";
import { getTournamentId } from "./core-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";
import { formatClock } from "./dealer-attendance-format.js";
import { maybePruneAttendanceLogsForTournament } from "../shared/attendance-log-retention.js";

export { writeAttendanceLog };

function getAttendanceActionLabel(action) {
  if (action === "checked_in") return "출근";
  if (action === "waiting") return "대기";
  if (action === "assigned") return "배치";
  if (action === "break") return "휴식";
  if (action === "checked_out") return "퇴근";
  if (action === "adjust_check_in") return "출근 시각 수정";
  if (action === "adjust_check_out") return "퇴근 시각 수정";
  if (action === "operational_day_reset") return "운영일 전환 초기화";
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
  const ms = attendanceLogCreatedAtMs(ts);
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getFilteredAttendanceLogs() {
  const tournamentId = getTournamentId();
  const keyword = String(IX.attendanceLogUi.search || "").trim().toLowerCase();
  const actionFilter = String(IX.attendanceLogUi.action || "all").trim();

  return IX.attendanceLogs.filter((log) => {
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
  if (!IX.attendanceLogSummary) return;

  const filtered = getFilteredAttendanceLogs();
  const total = filtered.length;
  const selected = filtered.filter((log) => IX.attendanceLogUi.selectedIds.has(log.id)).length;
  const loaded = IX.attendanceLogs.length;
  const moreHint = attendanceLogHasMore ? " · 이전 로그 더 불러올 수 있음" : "";

  IX.attendanceLogSummary.textContent =
    total === 0
      ? `불러온 로그 0건${moreHint}`
      : `불러온 로그 ${loaded}건 · 표시 ${total}건${selected > 0 ? ` · 선택 ${selected}건` : ""}${moreHint}`;
}

function updateAttendanceLogLoadMoreBtn() {
  const btn = IX.attendanceLogLoadMoreBtn;
  if (!btn) return;

  if (!attendanceLogHasMore) {
    btn.classList.add("hidden");
    btn.classList.remove("is-loading");
    btn.disabled = false;
    btn.textContent = "이전 로그 더 보기";
    return;
  }

  btn.classList.remove("hidden");
  btn.disabled = attendanceLogLoadingMore;
  btn.classList.toggle("is-loading", attendanceLogLoadingMore);
  btn.textContent = attendanceLogLoadingMore ? "불러오는 중…" : "이전 로그 더 보기";
}

let attendanceLogsFlushScheduled = false;

function scheduleAttendanceLogsRender() {
  if (attendanceLogsFlushScheduled) return;
  attendanceLogsFlushScheduled = true;
  requestAnimationFrame(() => {
    attendanceLogsFlushScheduled = false;
    renderAttendanceLogs();
  });
}

function renderAttendanceLogs() {
  if (!IX.attendanceLogList) return;

  const filtered = getFilteredAttendanceLogs();

  updateAttendanceLogSummary();
  updateAttendanceLogLoadMoreBtn();

  if (!filtered.length) {
    IX.attendanceLogList.innerHTML = `
      <div class="attendance-log-empty">
        표시할 운영 로그가 없습니다.
      </div>
    `;
    return;
  }

  IX.attendanceLogList.innerHTML = filtered.map((log) => {
    const id = String(log.id || "");
    const checked = IX.attendanceLogUi.selectedIds.has(id);
    const action = String(log.action || "").trim();
    const nickname = escapeHtml(log.nickname || "이름 없음");
    const timeText = formatLogDateTime(log.createdAt);

    const actionPill = `<span class="attendance-log-pill strong">${escapeHtml(getAttendanceActionLabel(action))}</span>`;
    const meta = [];

    if (log.eventId) {
      meta.push(`<span class="attendance-log-pill">Event ${escapeHtml(log.eventId)}</span>`);
    }

    if (log.boxId) {
      meta.push(`<span class="attendance-log-pill">Box ${escapeHtml(log.boxId)}</span>`);
    }

    if (log.seatLabel) {
      meta.push(`<span class="attendance-log-pill">Seat ${escapeHtml(log.seatLabel)}</span>`);
    }

    if (action === "adjust_check_in" || action === "adjust_check_out") {
      const prev =
        action === "adjust_check_out"
          ? Number(log.previousCheckedOutAt || 0)
          : Number(log.previousCheckedInAt || 0);
      const next =
        action === "adjust_check_out"
          ? Number(log.newCheckedOutAt || 0)
          : Number(log.newCheckedInAt || 0);
      if (prev && next) {
        meta.push(
          `<span class="attendance-log-pill">${escapeHtml(formatClock(prev))} → ${escapeHtml(formatClock(next))}</span>`
        );
      } else if (log.detail) {
        meta.push(`<span class="attendance-log-pill">${escapeHtml(log.detail)}</span>`);
      }
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
            ${actionPill}
          </div>
          <div class="attendance-log-time">${escapeHtml(timeText)}</div>
        </div>

        <div class="attendance-log-meta">
          ${meta.join("")}
        </div>

      </div>
    `;
  }).join("");
}

export function disposeAttendanceLogsRealtime() {
  if (IX.stopAttendanceLogsWatch) {
    IX.stopAttendanceLogsWatch();
    IX.stopAttendanceLogsWatch = null;
  }
}

/** 한 페이지당 조회 건수 */
const ATTENDANCE_LOG_PAGE_SIZE = 500;

let attendanceLogsFirstPage = [];
let attendanceLogsOlder = [];
let attendanceLogOldestDoc = null;
let attendanceLogHasMore = false;
let attendanceLogLoadingMore = false;

function mapAttendanceLogDoc(docSnap) {
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    ...data,
    createdAt: attendanceLogCreatedAtMs(data.createdAt) || data.createdAt
  };
}

function mergeAttendanceLogArrays(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const log of group) {
      byId.set(String(log.id || ""), log);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => attendanceLogCreatedAtMs(b.createdAt) - attendanceLogCreatedAtMs(a.createdAt)
  );
}

function syncAttendanceLogsFromPages() {
  IX.attendanceLogs = mergeAttendanceLogArrays(attendanceLogsFirstPage, attendanceLogsOlder);
}

function resetAttendanceLogPagination() {
  attendanceLogsFirstPage = [];
  attendanceLogsOlder = [];
  attendanceLogOldestDoc = null;
  attendanceLogHasMore = false;
  attendanceLogLoadingMore = false;
  IX.attendanceLogs = [];
}

function buildAttendanceLogsQuery({ tournamentId = "", pageCursor = null } = {}) {
  const col = collection(db, "dealer_attendance_logs");
  const constraints = [];

  if (tournamentId) {
    constraints.push(where("tournamentId", "==", tournamentId));
  }

  constraints.push(orderBy("createdAt", "desc"));

  if (pageCursor) {
    constraints.push(startAfter(pageCursor));
  }

  constraints.push(limit(ATTENDANCE_LOG_PAGE_SIZE));
  return query(col, ...constraints);
}

function applyAttendanceLogPage(docs, { append = false } = {}) {
  const mapped = docs.map(mapAttendanceLogDoc);

  if (append) {
    attendanceLogsOlder = mergeAttendanceLogArrays(attendanceLogsOlder, mapped);
    if (docs.length) {
      attendanceLogOldestDoc = docs[docs.length - 1];
    }
    attendanceLogHasMore = docs.length >= ATTENDANCE_LOG_PAGE_SIZE;
  } else {
    attendanceLogsFirstPage = mapped;
    // 이전 페이지를 이미 불러온 경우 커서는 유지 (실시간 1페이지 갱신이 페이지네이션을 깨지 않도록).
    if (!attendanceLogsOlder.length) {
      attendanceLogOldestDoc = docs.length ? docs[docs.length - 1] : null;
      attendanceLogHasMore = docs.length >= ATTENDANCE_LOG_PAGE_SIZE;
    }
  }

  syncAttendanceLogsFromPages();
}

/**
 * 출근 로그 — 모달을 열 때만 구독 (전체 collection 상시 listen 방지)
 * 최신 500건은 서버 우선 로드 후 실시간 구독, 이전 이력은 "더 보기"로 500건씩 페이지네이션.
 */
export function bindAttendanceLogsRealtime() {
  disposeAttendanceLogsRealtime();

  const tournamentId = getTournamentId();
  const q = buildAttendanceLogsQuery({ tournamentId });

  void (async () => {
    try {
      const snap = await getDocsFromServer(q);
      applyAttendanceLogPage(snap.docs, { append: false });
      scheduleAttendanceLogsRender();
    } catch (err) {
      console.warn("bindAttendanceLogsRealtime server load:", err?.code || err);
    }
  })();

  IX.stopAttendanceLogsWatch = onSnapshot(
    q,
    (snap) => {
      applyAttendanceLogPage(snap.docs, { append: false });

      const validIds = new Set(IX.attendanceLogs.map((log) => String(log.id || "")));
      IX.attendanceLogUi.selectedIds.forEach((id) => {
        if (!validIds.has(id)) {
          IX.attendanceLogUi.selectedIds.delete(id);
        }
      });

      scheduleAttendanceLogsRender();
    },
    (err) => {
      console.error("bindAttendanceLogsRealtime error:", err);
    }
  );
}

async function loadMoreAttendanceLogs() {
  if (attendanceLogLoadingMore || !attendanceLogHasMore || !attendanceLogOldestDoc) return;

  attendanceLogLoadingMore = true;
  updateAttendanceLogLoadMoreBtn();

  try {
    const tournamentId = getTournamentId();
    const snap = await getDocs(
      buildAttendanceLogsQuery({ tournamentId, pageCursor: attendanceLogOldestDoc })
    );
    applyAttendanceLogPage(snap.docs, { append: true });
    scheduleAttendanceLogsRender();
  } catch (err) {
    console.error("loadMoreAttendanceLogs error:", err);
    alert("이전 로그를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    attendanceLogLoadingMore = false;
    updateAttendanceLogLoadMoreBtn();
  }
}

function openAttendanceLogModal() {
  resetAttendanceLogPagination();
  bindAttendanceLogsRealtime();
  const tid = getTournamentId();
  void maybePruneAttendanceLogsForTournament(tid, {
    isAdmin: canUseTournamentOps(auth.currentUser?.email, IX.currentUserProfile, tid)
  });
  renderAttendanceLogs();
  openModal(IX.attendanceLogModal);
}

function closeAttendanceLogModal() {
  disposeAttendanceLogsRealtime();
  resetAttendanceLogPagination();
  closeModal(IX.attendanceLogModal);
}

async function deleteSelectedAttendanceLogs() {
  const ids = Array.from(IX.attendanceLogUi.selectedIds);
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

    IX.attendanceLogUi.selectedIds.clear();
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

    IX.attendanceLogUi.selectedIds.clear();
  } catch (err) {
    console.error("clearAttendanceLogs error:", err);
    alert("전체 로그 초기화에 실패했습니다.");
  }
}

export function setupAttendanceLogEvents() {
  refreshIndexDomRefs();
  if (IX.attendanceLogEventsBound) return;

  if (!IX.attendanceLogModal && !IX.attendanceLogBtn) {
    return;
  }

  IX.attendanceLogBtn?.addEventListener("click", () => {
    if (!canUseTournamentOps(auth.currentUser?.email, IX.currentUserProfile, getTournamentId())) {
      return;
    }
    openAttendanceLogModal();
  });

  IX.closeAttendanceLogBtn?.addEventListener("click", closeAttendanceLogModal);

  IX.attendanceLogModal?.addEventListener("click", (e) => {
    if (e.target === IX.attendanceLogModal) {
      closeAttendanceLogModal();
    }
  });

  IX.attendanceLogSearch?.addEventListener("input", (e) => {
    IX.attendanceLogUi.search = String(e.target.value || "");
    renderAttendanceLogs();
  });

  IX.attendanceLogActionFilter?.addEventListener("change", (e) => {
    IX.attendanceLogUi.action = String(e.target.value || "all");
    renderAttendanceLogs();
  });

  IX.attendanceLogList?.addEventListener("change", (e) => {
    const checkbox = e.target.closest("[data-log-check]");
    if (!checkbox) return;

    const id = String(checkbox.getAttribute("data-log-check") || "").trim();
    if (!id) return;

    if (checkbox.checked) {
      IX.attendanceLogUi.selectedIds.add(id);
    } else {
      IX.attendanceLogUi.selectedIds.delete(id);
    }

    updateAttendanceLogSummary();
  });

  IX.deleteSelectedAttendanceLogsBtn?.addEventListener("click", deleteSelectedAttendanceLogs);
  IX.clearAttendanceLogsBtn?.addEventListener("click", clearAttendanceLogs);
  IX.attendanceLogLoadMoreBtn?.addEventListener("click", () => {
    void loadMoreAttendanceLogs();
  });

  IX.attendanceLogEventsBound = true;
}
