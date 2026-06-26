import { filterAttendanceDocsForTournament } from "./dealer-attendance-query.js";
import { isStaleOperationalDayAttendance } from "./attendance-operational-day.js";

const TERMINAL_ATTENDANCE = new Set(["checked_out", "off"]);

function isUidQueuedInGlobalWaiting(globalWaiting = [], tournamentId = "", uid = "") {
  const safeUid = String(uid || "").trim();
  const tid = String(tournamentId || "").trim();
  if (!safeUid || !tid) return false;
  for (const w of globalWaiting || []) {
    if (String(w?.uid || "").trim() !== safeUid) continue;
    const wTid = String(w?.tournamentId || "").trim();
    if (wTid && wTid !== tid) continue;
    return true;
  }
  return false;
}

/** dealer_attendance 문서에서 퇴근·미출근 uid 집합 */
export function buildAttendanceInactiveUidSet(docs = [], tournamentId = "", globalWaiting = []) {
  const inactive = new Set();
  for (const d of filterAttendanceDocsForTournament(docs, tournamentId)) {
    const data = typeof d.data === "function" ? d.data() || {} : d;
    const uid = String(data.uid || "").trim();
    const status = String(data.status || "").trim();
    if (uid && TERMINAL_ATTENDANCE.has(status)) inactive.add(uid);
    if (
      uid &&
      isStaleOperationalDayAttendance(data) &&
      !isUidQueuedInGlobalWaiting(globalWaiting, tournamentId, uid)
    ) {
      inactive.add(uid);
    }
  }
  return inactive;
}

/** Firestore 대기열 정리 — 퇴근·미출근만 (운영일 stale 은 대기열에 있으면 유지) */
export function buildTerminalAttendanceUidSet(docs = [], tournamentId = "") {
  const terminal = new Set();
  for (const d of filterAttendanceDocsForTournament(docs, tournamentId)) {
    const data = typeof d.data === "function" ? d.data() || {} : d;
    const uid = String(data.uid || "").trim();
    const status = String(data.status || "").trim();
    if (uid && TERMINAL_ATTENDANCE.has(status)) terminal.add(uid);
  }
  return terminal;
}

export function filterAttendanceRowsForWaitingMerge(rows = []) {
  return rows.filter((row) => {
    const status = String(row?.status || "").trim();
    return status === "waiting" || status === "checked_in";
  });
}

/** global_waiting 행 — 퇴근·미출근 uid 제외 */
export function isInactiveWaitingEntry(entry = {}, inactiveUids = null) {
  const inactive = inactiveUids instanceof Set ? inactiveUids : new Set();
  const uid = String(entry?.uid || "").trim();
  return !!(uid && inactive.has(uid));
}
