import {
  buildAttendanceInactiveUidSet,
  filterAttendanceRowsForWaitingMerge
} from "./attendance-waiting-filter.js";

/** global_waiting 행 — tournamentId 없는 레거시 데이터도 현재 대회에 포함 */
export function waitingRowBelongsToTournament(row = {}, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return false;
  const wTid = String(row?.tournamentId || "").trim();
  if (!wTid) return true;
  return wTid === tid;
}

export function isWaitingBlockedRow(raw = {}) {
  return raw?.blockChecked === true;
}

function personSeatedByUid(uid = "", seatedUids = null) {
  const id = String(uid || "").trim();
  return !!(id && seatedUids instanceof Set && seatedUids.has(id));
}

/**
 * 통합배치도·딜러 운영 현황 공통 — 현재 대회 대기열(배치 가능) 인원 수
 */
export function countTournamentWaitingQueue({
  globalWaiting = [],
  tournamentId = "",
  attendanceInactiveUids = null,
  seatedUids = null,
  attendanceFilterReady = false,
  excludeBlocked = true
} = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return 0;
  const inactive = attendanceInactiveUids instanceof Set ? attendanceInactiveUids : new Set();

  let n = 0;
  for (const w of globalWaiting || []) {
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    const uid = String(w?.uid || "").trim();
    if (attendanceFilterReady && uid && inactive.has(uid)) continue;
    if (personSeatedByUid(uid, seatedUids)) continue;
    if (excludeBlocked && isWaitingBlockedRow(w)) continue;
    n += 1;
  }
  return n;
}

/** tournaments/{tid}/global_seats 점유 좌석 수 */
export function countTournamentOccupiedSeats(seats = []) {
  let n = 0;
  for (const s of seats || []) {
    const person = String(s?.person || "").trim();
    if (!person || person === "비어있음") continue;
    n += 1;
  }
  return n;
}

/** index dealerSeatMap 기준 점유 인원 (global_seats 스냅샷과 동일) */
export function countTournamentOccupiedFromSeatMap(seatMap = null) {
  if (!(seatMap instanceof Map)) return 0;
  return seatMap.size;
}

export function buildIndexAttendanceInactiveUids(dealerAttendanceMap = null, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid || !(dealerAttendanceMap instanceof Map)) return new Set();
  const docs = [];
  dealerAttendanceMap.forEach((data, id) => {
    docs.push({ id, data: () => data || {} });
  });
  return buildAttendanceInactiveUidSet(docs, tid);
}

export function buildIndexAttendanceWaitingRows(dealerAttendanceMap = null, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid || !(dealerAttendanceMap instanceof Map)) return [];
  const rows = [];
  dealerAttendanceMap.forEach((data, id) => {
    if (!String(id || "").startsWith(`${tid}__`)) return;
    rows.push({ id, ...(data || {}) });
  });
  return filterAttendanceRowsForWaitingMerge(rows);
}
