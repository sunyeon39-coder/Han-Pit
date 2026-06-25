import {
  buildAttendanceInactiveUidSet,
  filterAttendanceRowsForWaitingMerge,
  isInactiveWaitingEntry
} from "./attendance-waiting-filter.js";

function isEmptySeatPerson(name = "") {
  const v = String(name || "").trim();
  return !v || v === "비어있음";
}

/** global_seats 점유자 식별 — uid·email·이름(무 uid) */
export function buildSeatedIdentitySet(seats = []) {
  const set = new Set();
  for (const s of seats || []) {
    if (isEmptySeatPerson(s?.person)) continue;
    const uid = String(s?.personUid || "").trim();
    const email = String(s?.personEmail || "").trim().toLowerCase();
    const name = String(s?.person || "").trim();
    if (uid) set.add(`uid:${uid}`);
    if (email) set.add(`email:${email}`);
    if (!uid && !email && name) set.add(`name:${name}`);
  }
  return set;
}

export function isPersonSeatedInIdentitySet(set, person = {}) {
  const seated = set instanceof Set ? set : new Set();
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || person.nickname || "").trim();
  if (uid && seated.has(`uid:${uid}`)) return true;
  if (email && seated.has(`email:${email}`)) return true;
  if (!uid && !email && name && seated.has(`name:${name}`)) return true;
  return false;
}

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

/**
 * 통합배치도·딜러 운영 현황 공통 — 현재 대회 대기열 인원 수
 * (통합배치도 대기 목록과 동일 필터: 퇴근·좌석 제외, BLOCK 포함 여부 선택)
 */
export function countTournamentWaitingQueue({
  globalWaiting = [],
  tournamentId = "",
  attendanceInactiveUids = null,
  seatedUids = null,
  globalSeats = null,
  attendanceFilterReady = false,
  excludeBlocked = true
} = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return 0;
  const inactive = attendanceInactiveUids instanceof Set ? attendanceInactiveUids : new Set();
  const seatedSet =
    Array.isArray(globalSeats) && globalSeats.length
      ? buildSeatedIdentitySet(globalSeats)
      : null;

  let n = 0;
  for (const w of globalWaiting || []) {
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    if (attendanceFilterReady && isInactiveWaitingEntry(w, inactive)) continue;
    const person = { uid: w?.uid, email: w?.email, name: w?.name };
    if (seatedSet) {
      if (isPersonSeatedInIdentitySet(seatedSet, person)) continue;
    } else {
      const uid = String(w?.uid || "").trim();
      if (uid && seatedUids instanceof Set && seatedUids.has(uid)) continue;
    }
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

/** index dealerSeatMap 기준 점유 인원 (uid 있는 좌석만) */
export function countTournamentOccupiedFromSeatMap(seatMap = null) {
  if (!(seatMap instanceof Map)) return 0;
  return seatMap.size;
}

/** global_seats 스냅샷 — person 기준 점유 수 (uid 없는 좌석 포함) */
export function countTournamentOccupiedFromGlobalSeats(seats = []) {
  return countTournamentOccupiedSeats(seats);
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
