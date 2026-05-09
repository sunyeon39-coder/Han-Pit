import { auth, db } from "../firebase.js";
import {
  collection,
  doc,
  deleteDoc,
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import { getTournamentId } from "./core-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";

export async function writeAttendanceLog({
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

  IX.attendanceLogSummary.textContent =
    total === 0
      ? "최근 로그 0건"
      : `최근 로그 ${total}건${selected > 0 ? ` · 선택 ${selected}건` : ""}`;
}

function renderAttendanceLogs() {
  if (!IX.attendanceLogList) return;

  const filtered = getFilteredAttendanceLogs();

  updateAttendanceLogSummary();

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

export function bindAttendanceLogsRealtime() {
  if (IX.stopAttendanceLogsWatch) {
    IX.stopAttendanceLogsWatch();
    IX.stopAttendanceLogsWatch = null;
  }

  IX.stopAttendanceLogsWatch = onSnapshot(
    collection(db, "dealer_attendance_logs"),
    (snap) => {
      IX.attendanceLogs = snap.docs
        .map((d) => ({
          id: d.id,
          ...(d.data() || {})
        }))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      const validIds = new Set(IX.attendanceLogs.map((log) => String(log.id || "")));
      IX.attendanceLogUi.selectedIds.forEach((id) => {
        if (!validIds.has(id)) {
          IX.attendanceLogUi.selectedIds.delete(id);
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
  openModal(IX.attendanceLogModal);
}

function closeAttendanceLogModal() {
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
    const isAdmin = getIsAdmin(auth.currentUser, IX.currentUserProfile);
    if (!isAdmin) return;
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

  IX.attendanceLogEventsBound = true;
}
