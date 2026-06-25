import { waitingRowMatchesPerson } from "./fs-waiting-merge.js";
import { GL } from "./state.js";
import { resolveAttendanceWaitingJoinMs, resolveAttendanceWaitingStatusChangedMs } from "../shared/attendance-operational-day.js";
import { isInactiveWaitingEntry } from "../shared/attendance-waiting-filter.js";
import { waitingRowBelongsToTournament as sharedWaitingRowBelongsToTournament } from "../shared/tournament-waiting-queue.js";
import { fmtElapsed, isEmptyPerson, makeUid, timerClass, toMillis } from "./utils.js";
import { bumpGlobalLayoutDataRevision } from "./realtime-ui.js";

function toPositiveMs(v) {
  const ms = toMillis(v);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

function waitingPersonIdentityKey(raw = {}) {
  const uid = String(raw?.uid || "").trim();
  const email = String(raw?.email || "").trim().toLowerCase();
  const name = String(raw?.name || raw?.nickname || "").trim();
  if (uid) return `uid:${uid}`;
  if (email) return `email:${email}`;
  if (name) return `name:${name}`;
  return "";
}

function isSameWaitingPerson(a = {}, b = {}) {
  const aUid = String(a?.uid || "").trim();
  const bUid = String(b?.uid || "").trim();
  const aEmail = String(a?.email || "").trim().toLowerCase();
  const bEmail = String(b?.email || "").trim().toLowerCase();
  const aName = String(a?.name || a?.nickname || "").trim();
  const bName = String(b?.name || b?.nickname || "").trim();
  if (aUid && bUid && aUid === bUid) return true;
  if (aEmail && bEmail && aEmail === bEmail) return true;
  if (!aUid && !aEmail && aName && bName === aName) return true;
  return false;
}

function findGlobalWaitingForPerson(raw = {}, tournamentId = "") {
  const tid = String(tournamentId || GL.tournamentId || "").trim();
  const wid = String(raw?.id || "").trim();
  const list = Array.isArray(GL.globalWaiting) ? GL.globalWaiting : [];

  if (wid) {
    const byId = list.find(
      (w) => waitingRowBelongsToTournament(w, tid) && String(w?.id || "").trim() === wid
    );
    if (byId) return byId;
  }

  const key = waitingPersonIdentityKey(raw);
  if (!key) return null;
  return (
    list.find(
      (w) => waitingRowBelongsToTournament(w, tid) && waitingPersonIdentityKey(w) === key
    ) || null
  );
}

function copyWaitingBlockFields(row = {}, source = null) {
  if (!source || source.blockChecked !== true) {
    return {
      ...row,
      blockChecked: false,
      blockCheckedAt: null,
      blockAccumulatedMs: 0
    };
  }
  return {
    ...row,
    blockChecked: true,
    blockCheckedAt: source.blockCheckedAt ?? null,
    blockAccumulatedMs: Number(source.blockAccumulatedMs || 0) || 0
  };
}

function personInGlobalWaiting(person = {}, tournamentId = GL.tournamentId) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return false;
  return (GL.globalWaiting || []).some(
    (w) => waitingRowBelongsToTournament(w, tid) && waitingRowMatchesPerson(w, tid, person)
  );
}

function buildAttendanceFallbackWaitingRow(item = {}, attId = "") {
  const uid = String(item?.uid || "").trim();
  const id = String(attId || item?.id || `att_${uid || makeUid("att")}`).trim();
  const row = {
    id,
    uid,
    email: String(item.email || "").trim(),
    name: String(item.name || item.nickname || "").trim() || uid || "-",
    tournamentId: GL.tournamentId,
    joinedAt: resolveAttendanceWaitingJoinMs(item, Date.now()),
    source: "attendance_fallback"
  };
  return copyWaitingBlockFields(row, findGlobalWaitingForPerson({ ...row, id }, GL.tournamentId));
}

function materializeWaitingInGlobal(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid || !Array.isArray(GL.globalWaiting)) return null;

  const existing = GL.globalWaiting.find((w) => String(w?.id || "").trim() === wid);
  if (existing) return existing;

  const cached = GL._waitingListCache?.find((w) => String(w?.id || "").trim() === wid);
  if (cached) {
    GL.globalWaiting = [...GL.globalWaiting, { ...cached }];
    return cached;
  }

  for (const item of GL.attendanceWaiting || []) {
    const uid = String(item?.uid || "").trim();
    const attId = String(item.id || `att_${uid || makeUid("att")}`).trim();
    if (attId !== wid && wid !== uid && `att_${uid}` !== wid) continue;
    const row = buildAttendanceFallbackWaitingRow(item, attId);
    GL.globalWaiting = [...GL.globalWaiting, row];
    return row;
  }

  return null;
}

export function getWaitingJoinMs(raw = {}) {
  const keys = ["joinedAt", "createdAt", "joinedAtServer", "addedAt", "carryStartedAt"];
  for (const key of keys) {
    const ms = toPositiveMs(raw?.[key]);
    if (ms > 0) return ms;
  }
  return 0;
}

export function isWaitingBlocked(raw = {}) {
  return raw?.blockChecked === true;
}

/** global_waiting 행 — tournamentId 없는 레거시 데이터도 현재 대회에 포함 */
export function waitingRowBelongsToTournament(row = {}, tournamentId = "") {
  return sharedWaitingRowBelongsToTournament(row, tournamentId || GL.tournamentId);
}

/** BLOCK 체크 직후 상단 카운트용 — Firestore 스냅샷 전 로컬 대기 목록 반영 */
/** Firestore 전 global_waiting 배열을 로컬에 반영 (낙관적 추가·삭제) */
export function replaceGlobalWaitingLocal(nextWaiting = []) {
  GL.globalWaiting = Array.isArray(nextWaiting) ? [...nextWaiting] : [];
  bumpGlobalLayoutDataRevision();
}

export function applyWaitingBlockLocal(waitingId = "", checked = false) {
  const wid = String(waitingId || "").trim();
  if (!wid || !Array.isArray(GL.globalWaiting)) return;

  const now = Date.now();
  const nextChecked = checked === true;
  GL.dataRevision = (GL.dataRevision || 0) + 1;

  const seed =
    materializeWaitingInGlobal(wid) ||
    GL.globalWaiting.find((w) => String(w?.id || "").trim() === wid) ||
    null;

  GL.globalWaiting = GL.globalWaiting.map((w) => {
    const sameId = String(w?.id || "").trim() === wid;
    const samePerson = seed ? isSameWaitingPerson(w, seed) : false;
    if (!sameId && !samePerson) return w;

    const base = { ...w };
    if (nextChecked) {
      base.blockChecked = true;
      base.blockCheckedAt = now;
    } else {
      const startedAt = Number(base.blockCheckedAt || 0);
      const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
      base.blockChecked = false;
      base.blockCheckedAt = null;
      base.blockAccumulatedMs = Number(base.blockAccumulatedMs || 0) + elapsed;
    }
    return base;
  });
  GL._waitingListCache = null;
  GL._waitingListCacheRev = -1;
}

/** 목록 행 DOM — BLOCK 체크 직후 타이머·뱃지 즉시 반영 */
export function applyOptimisticWaitingBlockRow(row, checked) {
  if (!row) return;
  const now = Date.now();
  const nextChecked = checked === true;

  const joinMs = Number(row.getAttribute("data-wait-join-ms") || "0") || now;
  const prevAccumMs = Number(row.getAttribute("data-block-accum-ms") || "0") || 0;
  const prevCheckedAtMs = Number(row.getAttribute("data-block-checked-at-ms") || "0") || 0;
  const chip = row.querySelector(".time-chip[data-wait-start]");

  row.classList.toggle("is-blocked", nextChecked);

  const nameEl = row.querySelector(".seat-manage-name, .mobile-wait-name, .mobile-seat-person");
  let badge = row.querySelector(".wait-block-badge");
  if (nextChecked) {
    if (!badge && nameEl?.parentElement) {
      badge = document.createElement("span");
      badge.className = "wait-block-badge";
      badge.textContent = "BLOCK";
      nameEl.insertAdjacentElement("afterend", badge);
    }
  } else if (badge) {
    badge.remove();
  }

  let startMs = now;
  if (nextChecked) {
    row.setAttribute("data-block-checked-at-ms", String(now));
    startMs = now;
  } else {
    const effectiveCheckedAt = prevCheckedAtMs > 0 ? prevCheckedAtMs : now;
    const blockedElapsed = Math.max(0, now - effectiveCheckedAt);
    const nextAccumMs = prevAccumMs + blockedElapsed;
    row.setAttribute("data-block-accum-ms", String(nextAccumMs));
    row.setAttribute("data-block-checked-at-ms", "0");
    startMs = Math.min(now, joinMs + nextAccumMs);
  }

  if (!chip) return;
  chip.setAttribute("data-wait-start", String(startMs));
  const elapsed = Math.max(0, now - startMs);
  chip.textContent = fmtElapsed(elapsed);
  const cls = timerClass(elapsed);
  chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
  chip.classList.add(cls);
}

export function getWaitingDisplayStartMs(raw = {}) {
  const joinAnchor = getWaitingJoinMs(raw) || Date.now();
  const blockedAccumulatedMs = toPositiveMs(raw?.blockAccumulatedMs);
  if (isWaitingBlocked(raw)) {
    const checkedAt = toPositiveMs(raw?.blockCheckedAt);
    if (checkedAt > 0) return checkedAt;
  }
  if (blockedAccumulatedMs <= 0) return joinAnchor;
  const shifted = joinAnchor + blockedAccumulatedMs;
  const now = Date.now();
  return shifted > now ? joinAnchor : shifted;
}

function compareWaitingByOldestDisplayTime(a, b) {
  const da = getWaitingDisplayStartMs(a);
  const db = getWaitingDisplayStartMs(b);
  if (da !== db) return da - db;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

/** 표시 타이머 기준 오래된 순(위) */
export function sortWaitingByOldestDisplayTime(list = []) {
  return [...list].sort(compareWaitingByOldestDisplayTime);
}

/** PC 패널: 비블락 먼저(각각 오래된 순), 블락은 맨 아래(오래된 순) */
export function sortWaitingForDisplay(list = []) {
  return [...list].sort((a, b) => {
    const blockedA = isWaitingBlocked(a);
    const blockedB = isWaitingBlocked(b);
    if (blockedA !== blockedB) return blockedA ? 1 : -1;
    return compareWaitingByOldestDisplayTime(a, b);
  });
}

/** 모바일: 기본 대기 / BLOCK 각각 오래된 순 */
export function partitionWaitingForMobileDisplay(list = []) {
  const normal = [];
  const blocked = [];
  for (const w of list) {
    if (isWaitingBlocked(w)) blocked.push(w);
    else normal.push(w);
  }
  return {
    normal: sortWaitingByOldestDisplayTime(normal),
    blocked: sortWaitingByOldestDisplayTime(blocked)
  };
}

export function isPersonSeatedInGlobalSeats(seats, person = {}) {
  const set = buildSeatedIdentitySet(seats);
  return isPersonSeatedInIdentitySet(set, person);
}

function buildSeatedIdentitySet(seats = []) {
  const set = new Set();
  for (const s of seats) {
    if (isEmptyPerson(String(s?.person || "").trim())) continue;
    const uid = String(s?.personUid || "").trim();
    const email = String(s?.personEmail || "").trim().toLowerCase();
    const name = String(s?.person || "").trim();
    if (uid) set.add(`uid:${uid}`);
    if (email) set.add(`email:${email}`);
    if (!uid && !email && name) set.add(`name:${name}`);
  }
  return set;
}

function isPersonSeatedInIdentitySet(set, person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || person.nickname || "").trim();
  if (uid && set.has(`uid:${uid}`)) return true;
  if (email && set.has(`email:${email}`)) return true;
  if (!uid && !email && name && set.has(`name:${name}`)) return true;
  return false;
}

function getSeatedIdentitySet() {
  const rev = GL.dataRevision || 0;
  if (GL._seatedIdentitySet && GL._seatedIdentitySetRev === rev) {
    return GL._seatedIdentitySet;
  }
  const set = buildSeatedIdentitySet(GL.globalSeats);
  GL._seatedIdentitySet = set;
  GL._seatedIdentitySetRev = rev;
  return set;
}

export function getCurrentTournamentWaiting() {
  const rev = GL.dataRevision || 0;
  if (GL._waitingListCache && GL._waitingListCacheRev === rev) {
    return GL._waitingListCache;
  }

  const inactive = GL.attendanceInactiveUids instanceof Set ? GL.attendanceInactiveUids : new Set();
  const filterReady = GL.attendanceFilterReady === true;
  const seatedSet = getSeatedIdentitySet();

  const waitingBase = (GL.globalWaiting || [])
    .filter((w) => waitingRowBelongsToTournament(w, GL.tournamentId))
    .filter((w) => !filterReady || !isInactiveWaitingEntry(w, inactive))
    .filter((w) => !isPersonSeatedInIdentitySet(seatedSet, { uid: w?.uid, email: w?.email, name: w?.name }))
    .map((w) => {
      const uid = String(w?.uid || "").trim();
      if (!uid) return w;
      const att = (GL.attendanceWaiting || []).find((row) => String(row?.uid || "").trim() === uid);
      if (!att) return w;
      const rowJoin = getWaitingJoinMs(w);
      const attWaitChanged = resolveAttendanceWaitingStatusChangedMs(att);
      let healJoin = 0;
      if (attWaitChanged > rowJoin + 3000) {
        healJoin = attWaitChanged;
      } else if (!attWaitChanged) {
        const attJoin = resolveAttendanceWaitingJoinMs(att);
        // statusChangedAt 없을 때만 폴백 — 출석 시각이 더 최근일 때만 줄이고, 늘리지는 않음
        if (attJoin > rowJoin + 3000) healJoin = attJoin;
      }
      if (healJoin) {
        return { ...w, joinedAt: healJoin };
      }
      return w;
    });

  const merged = [...waitingBase];
  const hasEntry = (candidate = {}) => {
    const cUid = String(candidate.uid || "").trim();
    const cEmail = String(candidate.email || "").trim();
    const cName = String(candidate.name || "").trim();
    return merged.some((w) => {
      const wUid = String(w?.uid || "").trim();
      const wEmail = String(w?.email || "").trim();
      const wName = String(w?.name || "").trim();
      if (cUid && wUid && cUid === wUid) return true;
      if (cEmail && wEmail && cEmail === wEmail) return true;
      if (!cUid && !cEmail && cName && wName === cName) return true;
      return false;
    });
  };

  GL.attendanceWaiting.forEach((item) => {
    const uid = String(item?.uid || "").trim();
    if (filterReady && uid && inactive.has(uid)) return;
    if (
      isPersonSeatedInIdentitySet(seatedSet, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      return;
    }
    if (hasEntry(item)) return;
    // 출석 문서(waiting)만 남은 유령 행 — global_waiting(출근·수동추가·좌석해제) 없으면 표시 안 함
    if (
      uid &&
      !personInGlobalWaiting({
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      return;
    }
    merged.push(
      buildAttendanceFallbackWaitingRow(item, String(item.id || `att_${uid || makeUid("att")}`))
    );
  });

  GL._waitingListCache = merged;
  GL._waitingListCacheRev = rev;
  return merged;
}

/** BLOCK·배치 등 — 화면 id로 대기 행 조회 (출석 fallback·globalWaiting 포함) */
export function resolveWaitingEntryById(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid) return null;

  const inDisplay = getCurrentTournamentWaiting().find((w) => String(w?.id || "").trim() === wid);
  if (inDisplay) return inDisplay;

  const inactive = GL.attendanceInactiveUids instanceof Set ? GL.attendanceInactiveUids : new Set();

  const fromGlobal = (GL.globalWaiting || []).find((w) => {
    if (!waitingRowBelongsToTournament(w, GL.tournamentId)) return false;
    if (String(w?.id || "").trim() !== wid) return false;
    const uid = String(w?.uid || "").trim();
    if (uid && inactive.has(uid)) return false;
    return true;
  });
  if (fromGlobal) return fromGlobal;

  for (const item of GL.attendanceWaiting || []) {
    const uid = String(item?.uid || "").trim();
    const attId = String(item.id || `att_${uid || makeUid("att")}`).trim();
    if (attId !== wid && wid !== uid && `att_${uid}` !== wid) continue;
    if (uid && inactive.has(uid)) return null;
    if (
      uid &&
      !personInGlobalWaiting({
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      return null;
    }
    return buildAttendanceFallbackWaitingRow(item, attId);
  }

  return null;
}

/** 패널에 선택된 대기자 — 목록 필터(이미 좌석)와 무관하게 배치 트랜잭션용으로 조회 */
export function resolveSelectedWaitingForAssign() {
  const selId = String(GL.selectedWaitingId || "").trim();
  if (!selId) return null;
  return resolveWaitingEntryById(selId);
}
