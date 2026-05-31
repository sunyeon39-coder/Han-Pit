import { GL } from "./state.js";
import { isInactiveWaitingEntry } from "../shared/attendance-waiting-filter.js";
import { fmtElapsed, isEmptyPerson, makeUid, timerClass, toMillis } from "./utils.js";
import { bumpGlobalLayoutDataRevision } from "./realtime-ui.js";

function toPositiveMs(v) {
  const ms = toMillis(v);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

export function getWaitingJoinMs(raw = {}) {
  const keys = ["joinedAt", "createdAt", "joinedAtServer", "addedAt", "carryStartedAt"];
  for (const key of keys) {
    const ms = toPositiveMs(raw?.[key]);
    if (ms > 0) return ms;
  }
  return Date.now();
}

export function isWaitingBlocked(raw = {}) {
  return raw?.blockChecked === true;
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
  GL.globalWaiting = GL.globalWaiting.map((w) => {
    if (String(w?.id || "").trim() !== wid) return w;
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
  const joinAnchor = getWaitingJoinMs(raw);
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
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || person.nickname || "").trim();
  return seats.some((s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    const pUid = String(s?.personUid || "").trim();
    const pEmail = String(s?.personEmail || "").trim().toLowerCase();
    const pName = String(s?.person || "").trim();
    if (uid && pUid && uid === pUid) return true;
    if (email && pEmail && email === pEmail) return true;
    if (!uid && !email && name && pName === name) return true;
    return false;
  });
}

export function getCurrentTournamentWaiting() {
  const rev = GL.dataRevision || 0;
  if (GL._waitingListCache && GL._waitingListCacheRev === rev) {
    return GL._waitingListCache;
  }

  const inactive = GL.attendanceInactiveUids instanceof Set ? GL.attendanceInactiveUids : new Set();
  const filterReady = GL.attendanceFilterReady === true;

  const waitingBase = (filterReady ? GL.globalWaiting : [])
    .filter((w) => String(w?.tournamentId || "").trim() === GL.tournamentId)
    .filter((w) => !isInactiveWaitingEntry(w, inactive))
    .filter((w) =>
      !isPersonSeatedInGlobalSeats(GL.globalSeats, {
        uid: w?.uid,
        email: w?.email,
        name: w?.name
      })
    );

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
    if (
      isPersonSeatedInGlobalSeats(GL.globalSeats, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      return;
    }
    if (hasEntry(item)) return;
    merged.push({
      id: String(item.id || `att_${uid || makeUid("att")}`),
      uid,
      email: String(item.email || "").trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-",
      tournamentId: GL.tournamentId,
      joinedAt: Number(item.statusChangedAt || item.checkedInAt || Date.now()) || Date.now(),
      source: "attendance_fallback",
      blockChecked: false,
      blockCheckedAt: null,
      blockAccumulatedMs: 0
    });
  });

  GL._waitingListCache = merged;
  GL._waitingListCacheRev = rev;
  return merged;
}

/** 패널에 선택된 대기자 — 목록 필터(이미 좌석)와 무관하게 배치 트랜잭션용으로 조회 */
export function resolveSelectedWaitingForAssign() {
  const selId = String(GL.selectedWaitingId || "").trim();
  if (!selId) return null;

  const inDisplay = getCurrentTournamentWaiting().find((w) => String(w.id || "").trim() === selId);
  if (inDisplay) return inDisplay;

  const inactive = GL.attendanceInactiveUids instanceof Set ? GL.attendanceInactiveUids : new Set();

  const fromGlobal = GL.globalWaiting.find((w) => {
    if (String(w?.tournamentId || "").trim() !== GL.tournamentId) return false;
    if (String(w?.id || "").trim() !== selId) return false;
    const uid = String(w?.uid || "").trim();
    if (uid && inactive.has(uid)) return false;
    return true;
  });
  if (fromGlobal) return fromGlobal;

  for (const item of GL.attendanceWaiting || []) {
    const uid = String(item?.uid || "").trim();
    const attId = String(item.id || `att_${uid || makeUid("att")}`).trim();
    if (attId !== selId && selId !== uid && `att_${uid}` !== selId) continue;
    if (uid && inactive.has(uid)) return null;
    return {
      id: attId,
      uid,
      email: String(item.email || "").trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-",
      tournamentId: GL.tournamentId,
      joinedAt: Number(item.statusChangedAt || item.checkedInAt || Date.now()) || Date.now(),
      source: "attendance_fallback",
      blockChecked: false,
      blockCheckedAt: null,
      blockAccumulatedMs: 0
    };
  }

  return null;
}
