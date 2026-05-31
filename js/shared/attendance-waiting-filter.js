import { filterAttendanceDocsForTournament } from "./dealer-attendance-query.js";

const TERMINAL_ATTENDANCE = new Set(["checked_out", "off"]);

/** dealer_attendance 문서에서 퇴근·미출근 uid 집합 */
export function buildAttendanceInactiveUidSet(docs = [], tournamentId = "") {
  const inactive = new Set();
  for (const d of filterAttendanceDocsForTournament(docs, tournamentId)) {
    const data = typeof d.data === "function" ? d.data() || {} : d;
    const uid = String(data.uid || "").trim();
    const status = String(data.status || "").trim();
    if (uid && TERMINAL_ATTENDANCE.has(status)) inactive.add(uid);
  }
  return inactive;
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
