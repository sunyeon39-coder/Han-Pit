import {
  collection,
  collectionGroup,
  doc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  buildAttendanceInactiveUidSet,
  filterAttendanceRowsForWaitingMerge,
  isInactiveWaitingEntry
} from "./attendance-waiting-filter.js";

/** 대기자 1명 = 문서 1개 (tournaments/{tid}/global_waiting/{entryId}) */
export function globalWaitingCollectionRef(db, tournamentId) {
  return collection(db, "tournaments", String(tournamentId || "").trim(), "global_waiting");
}

export function globalWaitingDocRef(db, tournamentId, entryId) {
  return doc(db, "tournaments", String(tournamentId || "").trim(), "global_waiting", String(entryId || "").trim());
}

/** 모든 대회에 걸쳐 uid로 찾을 때 (예: 닉네임 동기화) */
export function globalWaitingCollectionGroupRef(db) {
  return collectionGroup(db, "global_waiting");
}

/** 운영자별 "찜한 대기자" 등 — global_waiting 문서 쓰기와 절대 같은 문서를 공유하지 않는다 */
export function operatorPicksDocRef(db, tournamentId) {
  return doc(db, "tournaments", String(tournamentId || "").trim(), "global_waiting_meta", "operatorPicks");
}

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

export function getWaitingRowJoinMs(row = {}) {
  const keys = ["joinedAt", "createdAt", "joinedAtServer", "addedAt", "carryStartedAt"];
  for (const key of keys) {
    const ms = Number(row?.[key] || 0);
    if (ms > 0) return ms;
  }
  return 0;
}

export function findGlobalWaitingRowForUid(globalWaiting = [], tournamentId = "", uid = "") {
  const safeUid = String(uid || "").trim();
  const tid = String(tournamentId || "").trim();
  if (!safeUid || !tid) return null;
  for (const w of globalWaiting || []) {
    if (String(w?.uid || "").trim() !== safeUid) continue;
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    return w;
  }
  return null;
}

/** global_waiting 에 대기 행이 있으면 출석 stale 리셋·대기열 제거 대상 아님 (joinedAt 운영일과 무관) */
export function hasFreshGlobalWaitingForUid(
  globalWaiting = [],
  tournamentId = "",
  uid = "",
  _nowMs = Date.now()
) {
  return !!findGlobalWaitingRowForUid(globalWaiting, tournamentId, uid);
}

/** 대기·좌석·출석 간 동일 인물 판정 — 양쪽 uid 가 있으면 uid 만, 없으면 email·이름 순 */
export function personIdentityMatches(left = {}, right = {}) {
  const lUid = String(left.uid || left.personUid || "").trim();
  const rUid = String(right.uid || right.personUid || "").trim();
  const lEmail = String(left.email || left.personEmail || "")
    .trim()
    .toLowerCase();
  const rEmail = String(right.email || right.personEmail || "")
    .trim()
    .toLowerCase();
  const lName = String(left.name || left.nickname || left.person || "").trim();
  const rName = String(right.name || right.nickname || right.person || "").trim();

  if (lUid && rUid) return lUid === rUid;
  if (lEmail && rEmail) return lEmail === rEmail;
  if (lName && rName) return lName === rName;
  return false;
}

/**
 * 좌석 점유 판정 — 대기열에서 "이미 배치된 사람" 을 숨기는 용도.
 * personIdentityMatches 는 양쪽 uid 가 다르면 이름이 같아도 즉시 false 를 반환한다.
 * 좌석 personUid 가 비었거나(수동 좌석) 옛 점유자 uid 로 남아 있으면, 같은 사람이
 * 대기+배치에 동시에 보이는 사고가 난다. 여기서는 uid·email·이름 중 하나라도
 * 일치하면 "배치됨" 으로 본다(단락 없이 OR). 표시명이 완전히 동일한 서로 다른
 * 딜러는 한쪽이 배치돼 있으면 대기에서 가려질 수 있으나, 운영상 그 편이 안전하다.
 */
export function isPersonSeatedInGlobalSeats(seats = [], person = {}) {
  const uid = String(person?.uid || person?.personUid || "").trim();
  const email = String(person?.email || person?.personEmail || "").trim().toLowerCase();
  const name = String(person?.name || person?.nickname || person?.person || "").trim();
  if (!uid && !email && !name) return false;
  for (const s of seats || []) {
    if (isEmptySeatPerson(s?.person)) continue;
    const sUid = String(s?.personUid || s?.uid || "").trim();
    const sEmail = String(s?.personEmail || s?.email || "").trim().toLowerCase();
    const sName = String(s?.person || s?.name || s?.nickname || "").trim();
    if (uid && sUid && uid === sUid) return true;
    if (email && sEmail && email === sEmail) return true;
    if (name && sName && name === sName) return true;
  }
  return false;
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

function waitingPersonIdentityKey(row = {}) {
  const uid = String(row?.uid || "").trim();
  const email = String(row?.email || "").trim().toLowerCase();
  const name = String(row?.name || row?.nickname || "").trim();
  if (uid) return `uid:${uid}`;
  if (email) return `email:${email}`;
  if (name) return `name:${name}`;
  return "";
}

export { waitingPersonIdentityKey };

const SEAT_RETURN_SOURCES = new Set(["seat_clear", "seat_swap", "seat_removed_recovery"]);
/** 한쪽 joinedAt 이 다른 쪽보다 이만큼 오래됐으면 "좌석에 있던 시간을 끌고온" 유령 행으로 본다 */
const STALE_JOIN_GAP_MS = 30 * 60 * 1000;

function preferWaitingDisplayRow(a = {}, b = {}) {
  const blockedA = a?.blockChecked === true;
  const blockedB = b?.blockChecked === true;
  if (blockedA !== blockedB) return blockedA ? a : b;

  // 좌석에서 방금 돌아온 행(타이머 리셋된 정본) 우선 — 예전 대기 문서가 안 지워져
  // 좌석 착석 시간을 그대로 표시하는 유령 행보다 이쪽을 남긴다.
  const retA = SEAT_RETURN_SOURCES.has(String(a?.source || "").trim());
  const retB = SEAT_RETURN_SOURCES.has(String(b?.source || "").trim());
  if (retA !== retB) return retA ? a : b;

  const joinA = getWaitingRowJoinMs(a);
  const joinB = getWaitingRowJoinMs(b);
  // source 태그가 없어도, joinedAt 이 크게 벌어지면 최근에 큐에 다시 들어온 쪽을 정본으로.
  if (joinA && joinB && Math.abs(joinA - joinB) > STALE_JOIN_GAP_MS) {
    return joinA > joinB ? a : b;
  }

  const idA = String(a?.id || "").trim();
  const idB = String(b?.id || "").trim();
  const score = (id = "") => {
    if (id.startsWith("w_")) return 3;
    if (id.startsWith("att_")) return 2;
    if (id.startsWith("wait_")) return 1;
    return 0;
  };
  if (score(idA) !== score(idB)) return score(idA) > score(idB) ? a : b;

  if (joinA !== joinB) return joinA <= joinB ? a : b;
  return a;
}

/** uid 가 달라 1차 병합에서 빠진 동명(同名) 행을 한 번 더 합친다 */
function collapseWaitingRowsByName(rows = []) {
  const out = [];
  for (const row of rows) {
    const nm = String(row?.name || row?.nickname || "").trim();
    if (!nm) {
      out.push(row);
      continue;
    }
    const idx = out.findIndex((prev) => String(prev?.name || prev?.nickname || "").trim() === nm);
    if (idx < 0) out.push(row);
    else out[idx] = preferWaitingDisplayRow(out[idx], row);
  }
  return out;
}

/** 화면 목록 — 같은 사람 중복 행 제거, BLOCK 행 우선 (uid·이름-only 포함) */
export function dedupeWaitingDisplayRows(list = []) {
  const passthrough = [];
  const scoped = [];
  for (const row of list || []) {
    const key = waitingPersonIdentityKey(row);
    if (!key) {
      passthrough.push(row);
      continue;
    }
    scoped.push(row);
  }

  const merged = [];
  for (const row of scoped) {
    const idx = merged.findIndex((prev) => personIdentityMatches(prev, row));
    if (idx < 0) merged.push(row);
    else merged[idx] = preferWaitingDisplayRow(merged[idx], row);
  }

  // 2차: uid 가 서로 달라(또는 한쪽만 있어) 1차에서 안 합쳐졌지만 표시 이름이 같은 행 —
  // 좌석에서 돌아온 뒤 예전 대기 문서가 남아 "김도영 2개" 처럼 보이던 문제 대응.
  return [...passthrough, ...collapseWaitingRowsByName(merged)];
}

/** Firestore 저장 전 — 같은 사람 중복 global_waiting 행 병합 (uid·이름-only 포함) */
export function dedupeGlobalWaitingRows(rows = [], tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const passthrough = [];
  const scoped = [];
  for (const row of rows || []) {
    if (tid && !waitingRowBelongsToTournament(row, tid)) {
      passthrough.push(row);
      continue;
    }
    scoped.push(row);
  }

  const merged = [];
  for (const row of scoped) {
    const idx = merged.findIndex((prev) => personIdentityMatches(prev, row));
    if (idx < 0) merged.push(row);
    else merged[idx] = preferWaitingDisplayRow(merged[idx], row);
  }
  return [...passthrough, ...merged];
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

function blockFieldsFromWaitingRow(w = {}) {
  if (w?.blockChecked === true) {
    return {
      blockChecked: true,
      blockCheckedAt: w.blockCheckedAt ?? null,
      blockAccumulatedMs: Number(w.blockAccumulatedMs || 0) || 0
    };
  }
  return {
    blockChecked: false,
    blockCheckedAt: null,
    blockAccumulatedMs: Number(w.blockAccumulatedMs || 0) || 0
  };
}

/** getCurrentTournamentWaiting — 행마다 findGlobalWaitingBlockFields 반복 방지 */
export function buildGlobalWaitingBlockIndex(globalWaiting = [], tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const index = new Map();
  for (const w of globalWaiting || []) {
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    const key = waitingPersonIdentityKey(w);
    if (!key) continue;
    const patch = blockFieldsFromWaitingRow(w);
    const prev = index.get(key);
    if (!prev) index.set(key, patch);
    else if (patch.blockChecked && !prev.blockChecked) index.set(key, patch);
  }
  return index;
}

export function resolveGlobalWaitingBlockFields(index, globalWaiting = [], tournamentId = "", person = {}) {
  const key = waitingPersonIdentityKey(person);
  if (key && index?.has(key)) return index.get(key);
  return findGlobalWaitingBlockFields(globalWaiting, tournamentId, person);
}

export function findGlobalWaitingBlockFields(globalWaiting = [], tournamentId = "", person = {}) {
  const tid = String(tournamentId || "").trim();
  const uid = String(person?.uid || "").trim();
  const email = String(person?.email || "").trim();
  const name = String(person?.name || person?.nickname || "").trim();
  let fallback = null;
  for (const w of globalWaiting || []) {
    if (!waitingRowBelongsToTournament(w, tid)) continue;
    const wUid = String(w?.uid || "").trim();
    const wEmail = String(w?.email || "").trim();
    const wName = String(w?.name || "").trim();
    const samePerson =
      (uid && wUid && uid === wUid) ||
      (email && wEmail && email === wEmail) ||
      (name && wName && name === wName);
    if (!samePerson) continue;
    if (w?.blockChecked === true) {
      return {
        blockChecked: true,
        blockCheckedAt: w.blockCheckedAt ?? null,
        blockAccumulatedMs: Number(w.blockAccumulatedMs || 0) || 0
      };
    }
    fallback = {
      blockChecked: false,
      blockCheckedAt: null,
      blockAccumulatedMs: Number(w.blockAccumulatedMs || 0) || 0
    };
  }
  return fallback;
}

/**
 * 통합배치도 대기 패널·딜러 운영 현황 공통 — 화면에 보이는 대기 목록
 */
export function buildTournamentWaitingDisplayList({
  globalWaiting = [],
  tournamentId = "",
  attendanceInactiveUids = null,
  attendanceCheckedOutUids = null,
  globalSeats = [],
  attendanceFilterReady = false,
  attendanceWaitingRows = []
} = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return [];
  const inactive = attendanceInactiveUids instanceof Set ? attendanceInactiveUids : new Set();
  const checkedOut = attendanceCheckedOutUids instanceof Set ? attendanceCheckedOutUids : new Set();
  const filterReady = attendanceFilterReady === true;

  // global_waiting — 퇴근자는 제외. 미출근·수동 +대기는 유지.
  const waitingBase = (globalWaiting || [])
    .filter((w) => waitingRowBelongsToTournament(w, tid))
    .filter((w) => {
      if (!filterReady) return true;
      const uid = String(w?.uid || "").trim();
      return !(uid && checkedOut.has(uid));
    })
    .filter(
      (w) =>
        !isPersonSeatedInGlobalSeats(globalSeats, {
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
      isPersonSeatedInGlobalSeats(globalSeats, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      continue;
    }
    if (waitingDisplayHasEntry(merged, item)) continue;
    const blockFields =
      findGlobalWaitingBlockFields(globalWaiting, tid, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      }) || null;
    merged.push({
      ...item,
      id: String(item.id || `att_${uid || "row"}`).trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-",
      ...(blockFields || {})
    });
  }

  return dedupeWaitingDisplayRows(merged);
}

/** 퇴근·미출근(uid inactive) — Firestore 대기열 정리용 */
export function purgeInactiveFromGlobalWaitingRows(
  globalWaiting = [],
  inactiveUids = null,
  tournamentId = ""
) {
  const tid = String(tournamentId || "").trim();
  const inactive = inactiveUids instanceof Set ? inactiveUids : new Set();
  if (!inactive.size) return globalWaiting || [];
  return (globalWaiting || []).filter((w) => {
    if (tid && !waitingRowBelongsToTournament(w, tid)) return true;
    return !isInactiveWaitingEntry(w, inactive);
  });
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

export function buildIndexAttendanceInactiveUids(
  dealerAttendanceMap = null,
  tournamentId = "",
  globalWaiting = []
) {
  const tid = String(tournamentId || "").trim();
  if (!tid || !(dealerAttendanceMap instanceof Map)) return new Set();
  const docs = [];
  dealerAttendanceMap.forEach((data, id) => {
    docs.push({ id, data: () => data || {} });
  });
  return buildAttendanceInactiveUidSet(docs, tid, globalWaiting);
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

/**
 * global_waiting 에 없지만 출석이 waiting/checked_in 이고 좌석도 없는 사람 — 복구 후보
 */
export function buildMissingGlobalWaitingRestoreList({
  tournamentId = "",
  globalWaiting = [],
  globalSeats = [],
  attendanceWaitingRows = [],
  terminalUids = null,
  resolveJoinedAt = null
} = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return [];
  const terminal = terminalUids instanceof Set ? terminalUids : new Set();
  const resolveJoin =
    typeof resolveJoinedAt === "function"
      ? resolveJoinedAt
      : (row) => getWaitingRowJoinMs(row) || Date.now();
  const missing = [];

  for (const item of attendanceWaitingRows || []) {
    const uid = String(item?.uid || "").trim();
    if (uid && terminal.has(uid)) continue;
    const person = {
      uid,
      email: String(item?.email || "").trim(),
      name: String(item?.nickname || item?.name || "").trim()
    };
    if (!person.uid && !person.email && !person.name) continue;
    if (
      isPersonSeatedInGlobalSeats(globalSeats, {
        uid: person.uid,
        email: person.email,
        name: person.name
      })
    ) {
      continue;
    }
    if (personExistsInGlobalWaiting(globalWaiting, tid, person)) continue;
    missing.push({
      ...person,
      joinedAt: resolveJoin(item)
    });
  }
  return missing;
}
