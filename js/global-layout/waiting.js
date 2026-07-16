import { waitingRowMatchesPerson } from "./fs-waiting-merge.js";
import { GL } from "./state.js";
import { resolveAttendanceWaitingJoinMs, resolveAttendanceWaitingStatusChangedMs } from "../shared/attendance-operational-day.js";
import {
  waitingRowBelongsToTournament as sharedWaitingRowBelongsToTournament,
  buildTournamentWaitingDisplayList,
  isPersonSeatedInGlobalSeats as sharedIsPersonSeatedInGlobalSeats,
  findGlobalWaitingBlockFields,
  buildGlobalWaitingBlockIndex,
  resolveGlobalWaitingBlockFields,
  dedupeGlobalWaitingRows,
  waitingPersonIdentityKey,
  personIdentityMatches
} from "../shared/tournament-waiting-queue.js";
import { fmtElapsed, isEmptyPerson, makeUid, timerClass, toMillis } from "./utils.js";
import { bumpGlobalLayoutDataRevision } from "./realtime-ui.js";

function toPositiveMs(v) {
  const ms = toMillis(v);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
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
  GL.globalWaiting = dedupeGlobalWaitingRows(
    Array.isArray(nextWaiting) ? [...nextWaiting] : [],
    GL.tournamentId
  );
  bumpGlobalLayoutDataRevision();
}

export function setPendingWaitingBlock(target = {}, nextChecked = false, now = Date.now()) {
  const key = waitingPersonIdentityKey(target);
  if (!key) return;
  if (!GL.pendingWaitingBlockByPerson) GL.pendingWaitingBlockByPerson = new Map();

  const person = {
    uid: String(target.uid || "").trim(),
    email: String(target.email || "").trim(),
    name: String(target.name || target.nickname || "").trim()
  };

  if (nextChecked === true) {
    GL.pendingWaitingBlockByPerson.set(key, {
      target: person,
      blockChecked: true,
      blockCheckedAt: now,
      blockAccumulatedMs: Number(target.blockAccumulatedMs || 0) || 0
    });
    return;
  }

  const startedAt = Number(target.blockCheckedAt || 0);
  const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  GL.pendingWaitingBlockByPerson.set(key, {
    target: person,
    blockChecked: false,
    blockCheckedAt: null,
    blockAccumulatedMs: Number(target.blockAccumulatedMs || 0) + elapsed
  });
}

function findPendingBlockForPerson(row = {}) {
  if (!GL.pendingWaitingBlockByPerson?.size) return null;
  for (const pending of GL.pendingWaitingBlockByPerson.values()) {
    if (pending?.target && personIdentityMatches(row, pending.target)) return pending;
  }
  return null;
}

function deletePendingBlockForPerson(row = {}) {
  if (!GL.pendingWaitingBlockByPerson?.size) return;
  for (const [key, pending] of GL.pendingWaitingBlockByPerson.entries()) {
    if (pending?.target && personIdentityMatches(row, pending.target)) {
      GL.pendingWaitingBlockByPerson.delete(key);
      return;
    }
  }
}

function reconcilePendingWaitingBlocks(rows = []) {
  if (!GL.pendingWaitingBlockByPerson?.size) return rows;
  for (const row of rows) {
    const pending = findPendingBlockForPerson(row);
    if (!pending) continue;
    const rowBlocked = row.blockChecked === true;
    const wantBlocked = pending.blockChecked === true;
    if (rowBlocked === wantBlocked) deletePendingBlockForPerson(row);
  }
  return rows;
}

function applyPendingBlockPatch(row = {}, pending = null) {
  if (!pending) return row;
  const rowBlocked = row.blockChecked === true;
  const wantBlocked = pending.blockChecked === true;
  if (rowBlocked === wantBlocked) return row;
  if (wantBlocked) {
    return {
      ...row,
      blockChecked: true,
      blockCheckedAt: pending.blockCheckedAt ?? Date.now(),
      blockAccumulatedMs: Number(pending.blockAccumulatedMs || 0) || 0
    };
  }
  return {
    ...row,
    blockChecked: false,
    blockCheckedAt: null,
    blockAccumulatedMs: Number(pending.blockAccumulatedMs ?? row.blockAccumulatedMs ?? 0) || 0
  };
}

/** Firestore·heal·캐시 스냅샷 수신 시 BLOCK 상태를 안정적으로 병합 */
export function mergeIncomingGlobalWaiting(incoming = [], local = []) {
  const tid = String(GL.tournamentId || "").trim();
  let rows = dedupeGlobalWaitingRows(Array.isArray(incoming) ? [...incoming] : [], tid);

  rows = rows.map((remote) => {
    let row = { ...remote };
    const localPatch = findGlobalWaitingBlockFields(local, tid, row);
    if (localPatch?.blockChecked === true && row.blockChecked !== true) {
      row = { ...row, ...localPatch };
    }

    const pending = findPendingBlockForPerson(row);
    if (pending) {
      row = applyPendingBlockPatch(row, pending);
    }
    return row;
  });

  if (GL.pendingWaitingBlockByPerson?.size) {
    for (const [, pending] of GL.pendingWaitingBlockByPerson.entries()) {
      const hasMatch = rows.some((row) => personIdentityMatches(row, pending?.target || {}));
      if (hasMatch) continue;
      const localRow = (local || []).find((row) => personIdentityMatches(row, pending?.target || {}));
      if (localRow) {
        rows.push(applyPendingBlockPatch({ ...localRow }, pending));
      }
    }
  }

  rows = dedupeGlobalWaitingRows(rows, tid);
  return reconcilePendingWaitingBlocks(rows);
}

/** @deprecated mergeIncomingGlobalWaiting 사용 */
export function mergeRemoteGlobalWaitingPreservingLocalBlock(incoming = [], local = []) {
  return mergeIncomingGlobalWaiting(incoming, local);
}

function waitingRowMatchesBlockTarget(row = {}, waitingId = "", target = {}, tournamentId = "") {
  const wid = String(waitingId || "").trim();
  const tid = String(tournamentId || GL.tournamentId || "").trim();
  const targetTid = String(target?.tournamentId || tid).trim();
  const wTid = String(row?.tournamentId || "").trim();
  if (targetTid && wTid && targetTid !== wTid) return false;
  const wId = String(row?.id || "").trim();
  if (wid && wId === wid) return true;
  return waitingRowMatchesPerson(row, tid, target);
}

export function applyBlockFieldsToWaitingRow(row = {}, nextChecked = false, now = Date.now()) {
  const base = { ...row };
  if (nextChecked) {
    base.blockChecked = true;
    base.blockCheckedAt = now;
    return base;
  }
  const startedAt = Number(base.blockCheckedAt || 0);
  const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  base.blockChecked = false;
  base.blockCheckedAt = null;
  base.blockAccumulatedMs = Number(base.blockAccumulatedMs || 0) + elapsed;
  return base;
}

export function applyWaitingBlockToWaitingArray(arr = [], waitingId = "", target = {}, nextChecked = false, now = Date.now()) {
  const list = Array.isArray(arr) ? [...arr] : [];
  const tid = String(GL.tournamentId || "").trim();
  let changed = false;
  let matched = false;
  const next = list.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (!waitingRowMatchesBlockTarget(row, waitingId, target, tid)) return row;
    matched = true;
    const prevChecked = row.blockChecked === true;
    if (prevChecked === nextChecked) return row;
    changed = true;
    return applyBlockFieldsToWaitingRow(row, nextChecked, now);
  });

  if (!matched && nextChecked) {
    changed = true;
    next.push(
      applyBlockFieldsToWaitingRow(
        {
          id: String(waitingId || "").trim() || makeUid("wait"),
          uid: String(target.uid || "").trim(),
          email: String(target.email || "").trim(),
          name: String(target.name || "").trim(),
          tournamentId: tid,
          joinedAt: Number(target.joinedAt || target.createdAt || now) || now
        },
        true,
        now
      )
    );
  }

  return { next, changed };
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

  const blockTarget = seed || { id: wid };

  GL.globalWaiting = dedupeGlobalWaitingRows(
    GL.globalWaiting.map((w) => {
      if (!waitingRowMatchesBlockTarget(w, wid, blockTarget, GL.tournamentId)) return w;
      return applyBlockFieldsToWaitingRow(w, nextChecked, now);
    }),
    GL.tournamentId
  );
  const matched =
    GL.globalWaiting.find((w) =>
      waitingRowMatchesBlockTarget(w, wid, blockTarget, GL.tournamentId)
    ) || blockTarget;
  setPendingWaitingBlock(matched, nextChecked, now);
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
  return sharedIsPersonSeatedInGlobalSeats(seats, person);
}

export function getCurrentTournamentWaiting() {
  const rev = GL.dataRevision || 0;
  if (GL._waitingListCache && GL._waitingListCacheRev === rev) {
    return GL._waitingListCache;
  }

  const tid = String(GL.tournamentId || "").trim();
  const blockIndex = buildGlobalWaitingBlockIndex(GL.globalWaiting, tid);

  const merged = buildTournamentWaitingDisplayList({
    globalWaiting: GL.globalWaiting,
    tournamentId: GL.tournamentId,
    attendanceInactiveUids: GL.attendanceInactiveUids,
    attendanceCheckedOutUids: GL.attendanceCheckedOutUids,
    globalSeats: GL.globalSeats,
    attendanceFilterReady: GL.attendanceFilterReady === true,
    attendanceWaitingRows: GL.attendanceWaiting
  })
    .map((w) => {
      const blockFields = resolveGlobalWaitingBlockFields(
        blockIndex,
        GL.globalWaiting,
        tid,
        w
      );
      return blockFields ? { ...w, ...blockFields } : w;
    })
    .map((w) => {
    if (isWaitingBlocked(w)) return w;
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
      if (attJoin > rowJoin + 3000) healJoin = attJoin;
    }
    if (healJoin) {
      return { ...w, joinedAt: healJoin };
    }
    return w;
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
    return String(w?.id || "").trim() === wid;
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
