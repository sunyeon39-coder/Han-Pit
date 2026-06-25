import {
  buildAttendanceInactiveUidSet,
  filterAttendanceRowsForWaitingMerge,
  isInactiveWaitingEntry
} from "./attendance-waiting-filter.js";

function isEmptySeatPerson(name = "") {
  const v = String(name || "").trim();
  return !v || v === "비어있음";
}

/** global_seats 점유자 식별 — uid·email·이름(표시명) */
export function buildSeatedIdentitySet(seats = []) {
  const set = new Set();
  for (const s of seats || []) {
    if (isEmptySeatPerson(s?.person)) continue;
    const uid = String(s?.personUid || "").trim();
    const email = String(s?.personEmail || "").trim().toLowerCase();
    const name = String(s?.person || "").trim();
    if (uid) set.add(`uid:${uid}`);
    if (email) set.add(`email:${email}`);
    if (name) set.add(`name:${name}`);
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
  if (name && seated.has(`name:${name}`)) return true;
  return false;
}

export function personExistsInGlobalWaiting(globalWaiting = [], tournamentId = "", person = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return false;
  const uid = String(person?.uid || "").trim();
  const email = String(person?.email || "").trim();
  const name = String(person?.name || person?.nickname || "").trim();
  for (const w of globalWaiting || []) {
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    const wUid = String(w?.uid || "").trim();
    const wEmail = String(w?.email || "").trim();
    const wName = String(w?.name || "").trim();
    if (uid && wUid && uid === wUid) return true;
    if (email && wEmail && email === wEmail) return true;
    if (name && wName && name === wName) return true;
  }
  return false;
}

function waitingDisplayHasEntry(merged = [], candidate = {}) {
  const cUid = String(candidate.uid || "").trim();
  const cEmail = String(candidate.email || "").trim();
  const cName = String(candidate.name || candidate.nickname || "").trim();
  return merged.some((w) => {
    const wUid = String(w?.uid || "").trim();
    const wEmail = String(w?.email || "").trim();
    const wName = String(w?.name || "").trim();
    if (cUid && wUid && cUid === wUid) return true;
    if (cEmail && wEmail && cEmail === wEmail) return true;
    if (cName && wName && cName === wName) return true;
    return false;
  });
}

/**
 * 통합배치도 대기 패널·딜러 운영 현황 공통 — 화면에 보이는 대기 목록
 */
export function buildTournamentWaitingDisplayList({
  globalWaiting = [],
  tournamentId = "",
  attendanceInactiveUids = null,
  globalSeats = [],
  attendanceFilterReady = false,
  attendanceWaitingRows = []
} = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return [];
  const inactive = attendanceInactiveUids instanceof Set ? attendanceInactiveUids : new Set();
  const filterReady = attendanceFilterReady === true;
  const seatedSet = buildSeatedIdentitySet(globalSeats);

  const waitingBase = (globalWaiting || [])
    .filter((w) => waitingRowBelongsToTournament(w, tid))
    .filter((w) => !filterReady || !isInactiveWaitingEntry(w, inactive))
    .filter((w) =>
      !isPersonSeatedInIdentitySet(seatedSet, {
        uid: w?.uid,
        email: w?.email,
        name: w?.name
      })
    );

  const merged = [...waitingBase];

  for (const item of attendanceWaitingRows || []) {
    const uid = String(item?.uid || "").trim();
    if (filterReady && uid && inactive.has(uid)) continue;
    if (
      isPersonSeatedInIdentitySet(seatedSet, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      continue;
    }
    if (waitingDisplayHasEntry(merged, item)) continue;
    if (
      uid &&
      !personExistsInGlobalWaiting(globalWaiting, tid, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      continue;
    }
    merged.push({
      ...item,
      id: String(item.id || `att_${uid || "row"}`).trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-"
    });
  }

  return merged;
}

export function countTournamentWaitingDisplay(options = {}) {
  const { excludeBlocked = false } = options;
  const list = buildTournamentWaitingDisplayList(options);
  if (!excludeBlocked) return list.length;
  return list.filter((w) => !isWaitingBlockedRow(w)).length;
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
 * 통합배치도·딜러 운영 현황 공통 — WAIT 메타(배치 가능, BLOCK 제외)
 */
export function countTournamentWaitingQueue({
  globalWaiting = [],
  tournamentId = "",
  attendanceInactiveUids = null,
  seatedUids = null,
  globalSeats = null,
  attendanceFilterReady = false,
  attendanceWaitingRows = [],
  excludeBlocked = true
} = {}) {
  return countTournamentWaitingDisplay({
    globalWaiting,
    tournamentId,
    attendanceInactiveUids,
    globalSeats: Array.isArray(globalSeats) ? globalSeats : [],
    attendanceFilterReady,
    attendanceWaitingRows,
    excludeBlocked
  });
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
