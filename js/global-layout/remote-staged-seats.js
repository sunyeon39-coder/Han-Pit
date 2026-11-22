/**
 * "배치확인" 전 임시(staged) 배치를 다른 관리자 화면에도 보여준다.
 *
 * 임시 배치 자체(GL.pendingSeatAssignments)는 여전히 이 세션 로컬 상태이고 Firestore 좌석엔
 * 아무것도 쓰지 않는다. 다만 관리자 두 명이 동시에 같은 Seat(또는 같은 대기자)를 잡아 놓고
 * 서로 모른 채 배치확인을 누르는 실수가 잦아서, "누가 어느 Seat에 누구를 넣어두었는지"만
 * tournaments/{tid}/global_waiting_meta/operatorStaged 문서에 세션별로 올려 공유한다.
 *
 * 문서 모양: { staged: { "<uid>__<sessionId>": { uid, displayName, color, tournamentId,
 *   updatedAt(클라 ms), updatedAtServer(serverTimestamp), seats: { "<seatId>": { waitingId, name } } } } }
 * - 같은 계정으로 창을 두 개 열어도 서로 덮어쓰지 않게 세션 단위 키를 쓴다.
 * - 쓰기는 관리자만(firestore.rules), 읽는 쪽도 관리자 화면에서만 구독한다.
 * - 문서의 내 항목과 로컬 임시 배치가 다르면(새로고침·bfcache 복귀·쓰기 실패 등) 스냅샷마다
 *   맞춰 다시 쓴다(reconcile) — 예전 방식은 "마지막으로 쓴 값" 추적이 꼬이면 유령 표시가 남았다.
 * - 오래된 항목 판단은 서버 시각 기준. 기기 시계가 틀려도 살아 있는 항목을 숨기거나 지우지 않게,
 *   서버 시각과 내 시계의 차이(clockOffset)를 보정한 뒤에만 다른 세션 항목을 지운다.
 * - operatorPicks 문서는 좌석 배정 트랜잭션이 읽고 쓰므로, 충돌(재시도)을 피하려고 별도 문서를 쓴다.
 */
import { auth, db } from "../firebase.js";
import {
  doc,
  deleteField,
  FieldPath,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { GL } from "./state.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { getOperatorDisplayName, normalizeOperatorIdentity } from "./waiting-picks.js";

const STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const PUBLISH_DEBOUNCE_MS = 120;
/** 시간이 지나 오래된 항목이 되는 것도 화면에 반영되게 주기적으로 다시 평가 */
const REEVALUATE_MS = 60 * 1000;
/** 관리자 권한 확인(서버 검증)이 늦게 끝나는 경우 구독 시작을 기다리는 간격 */
const OPS_POLL_MS = 2000;

const SESSION_ID = (() => {
  try {
    const KEY = "hanpit_gl_staged_session_v1";
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const next = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(KEY, next);
    return next;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
})();

/** seatId → [{ key, uid, displayName, color, waitingId, name, seatId }] (내 세션 제외) */
let remoteBySeat = new Map();
/** waitingId → 같은 항목 목록 (내 세션 제외) */
let remoteByWaiting = new Map();
let remoteFingerprint = "";
let onRemoteChange = null;

let watchTid = "";
let unsubscribeDoc = null;
let opsPollTimer = 0;
let reevaluateTimer = 0;
let docLoaded = false;
let lastDocStaged = {};

let publishTimer = 0;
let heartbeatTimer = 0;
let writesInFlight = 0;
let writeChain = Promise.resolve();
/** pagehide ~ pageshow 사이 — 닫히는 중에 스냅샷이 와도 방금 지운 내 항목을 다시 쓰지 않게 */
let pageHidden = false;

/** 서버 시각 - 내 시계 (ms). 보정 전엔 null */
let clockOffset = null;
/** key → 마지막으로 본 updatedAtServer(ms) — 값이 바뀌는 순간을 서버 "지금"으로 보고 보정 */
let seenServerTs = new Map();

function myUid() {
  return String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
}

function mySessionKey() {
  const uid = myUid();
  return uid ? `${uid}__${SESSION_ID}` : "";
}

function stagedDocRef(tid) {
  return doc(db, "tournaments", String(tid || "").trim(), "global_waiting_meta", "operatorStaged");
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function seatsFingerprint(seats = {}) {
  return Object.keys(seats || {})
    .sort()
    .map((sid) => `${sid}=${String(seats[sid]?.waitingId || "")}/${String(seats[sid]?.name || "")}`)
    .join(",");
}

function buildMySeatsMap() {
  const seats = {};
  for (const [seatId, pending] of GL.pendingSeatAssignments.entries()) {
    const sid = String(seatId || "").trim();
    if (!sid) continue;
    seats[sid] = {
      waitingId: String(pending?.waiting?.id || "").trim(),
      name: String(pending?.waiting?.name || "").trim()
    };
  }
  return seats;
}

/** 항목 나이(ms). 서버 시각 보정이 됐으면 서버 기준, 아니면 (어쩔 수 없이) 각자 시계 기준 */
function entryAgeMs(entry, now = Date.now()) {
  const serverMs = tsToMs(entry?.updatedAtServer);
  if (clockOffset !== null && serverMs > 0) return now + clockOffset - serverMs;
  if (!serverMs && !entry?.updatedAt) return Number.POSITIVE_INFINITY;
  // 쓰기 직후(serverTimestamp 미확정)이거나 보정 전 — 클라 시각으로 판단
  const clientMs = Number(entry?.updatedAt || 0);
  return clientMs ? now - clientMs : 0;
}

async function writeMyEntry(tid, key, seats) {
  const ref = stagedDocRef(tid);
  const now = Date.now();
  const hasSeats = Object.keys(seats).length > 0;
  const value = hasSeats
    ? {
        uid: myUid(),
        displayName: getOperatorDisplayName(GL.userProfile, GL.currentUser),
        color: GL.layoutAccentColor || "",
        tournamentId: tid,
        updatedAt: now,
        updatedAtServer: serverTimestamp(),
        seats
      }
    : deleteField();

  // FieldPath 로 지정해야 uid 안의 문자가 경로로 해석되지 않고, 맵 전체가 교체돼(merge 아님)
  // 취소한 seat 이 남지 않는다. 시계 보정이 끝난 뒤에만 방치된 다른 세션 항목을 같이 지운다.
  const args = [new FieldPath("staged", key), value];
  if (clockOffset !== null && tid === watchTid) {
    for (const [otherKey, entry] of Object.entries(lastDocStaged || {})) {
      if (otherKey === key) continue;
      if (entryAgeMs(entry, now) > STALE_MS) args.push(new FieldPath("staged", otherKey), deleteField());
    }
  }
  writesInFlight += 1;
  try {
    await updateDoc(ref, ...args);
  } catch (err) {
    if (err?.code !== "not-found") throw err;
    if (hasSeats) await setDoc(ref, { staged: { [key]: value } }, { merge: true });
  } finally {
    writesInFlight = Math.max(0, writesInFlight - 1);
  }
}

function enqueueWrite(tid, key, seats) {
  writeChain = writeChain
    .then(() => writeMyEntry(tid, key, seats))
    .catch((err) => {
      console.warn("publishMyStagedSeats:", err?.code || err);
    });
  return writeChain;
}

function syncHeartbeat(active) {
  if (active && !heartbeatTimer) {
    heartbeatTimer = window.setInterval(() => publishMyStagedSeats({ immediate: true, force: true }), HEARTBEAT_MS);
  } else if (!active && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }
}

/**
 * 내 임시 배치가 바뀔 때마다 호출 — 디바운스 후 문서의 내 항목과 다르면 Firestore 에 반영.
 * 문서를 아직 못 받았으면 쓰지 않는다(받는 순간 reconcile 이 맞춰 쓴다).
 */
export function publishMyStagedSeats({ immediate = false, force = false } = {}) {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = 0;
  const run = () => {
    publishTimer = 0;
    const key = mySessionKey();
    const tid = String(GL.tournamentId || "").trim();
    if (!key || !tid || tid !== watchTid || !docLoaded || !canManageGlobalLayoutOps()) return;
    const seats = buildMySeatsMap();
    const hasSeats = Object.keys(seats).length > 0;
    syncHeartbeat(hasSeats);
    const docEntry = lastDocStaged?.[key];
    const same = seatsFingerprint(docEntry?.seats || {}) === seatsFingerprint(seats) && (hasSeats || !docEntry);
    if (same && !force) return;
    if (!hasSeats && !docEntry) return;
    void enqueueWrite(tid, key, seats);
  };
  if (immediate) run();
  else publishTimer = window.setTimeout(run, PUBLISH_DEBOUNCE_MS);
}

/** 문서의 내 항목이 로컬 임시 배치와 다르면 다시 쓴다 (쓰기·디바운스 진행 중이면 기다림) */
function reconcileMyEntry() {
  if (!docLoaded || publishTimer || writesInFlight > 0 || pageHidden) return;
  if (!canManageGlobalLayoutOps()) return;
  publishMyStagedSeats({ immediate: true });
}

function calibrateClock(staged, meta, isFirstSnapshot) {
  const mine = mySessionKey();
  const now = Date.now();
  for (const [key, entry] of Object.entries(staged)) {
    const serverMs = tsToMs(entry?.updatedAtServer);
    if (!serverMs) continue;
    const prev = seenServerTs.get(key) || 0;
    seenServerTs.set(key, serverMs);
    if (meta?.fromCache) continue;
    if (key === mine && Number(entry.updatedAt || 0) > 0) {
      // 내가 쓴 항목 — 내 시계(updatedAt)와 서버 확정 시각의 차이가 곧 offset
      clockOffset = serverMs - Number(entry.updatedAt);
    } else if (!isFirstSnapshot && serverMs !== prev) {
      // 다른 세션이 쓴 값 — 관측한 서버 시각은 항상 "실제 서버 지금" 이하이므로 하한값으로만 쓴다.
      // (재연결 때 예전 값이 늦게 도착해도 offset 이 뒤로 밀려 오래된 항목이 살아 보이지 않게)
      const lowerBound = serverMs - now;
      if (clockOffset === null || lowerBound > clockOffset) clockOffset = lowerBound;
    }
  }
}

function applyStagedDoc(data = {}, meta = {}, isFirstSnapshot = false) {
  const staged = data?.staged && typeof data.staged === "object" ? data.staged : {};
  lastDocStaged = staged;
  calibrateClock(staged, meta, isFirstSnapshot);
  recomputeRemote();
  reconcileMyEntry();
}

function recomputeRemote() {
  const staged = lastDocStaged || {};
  const tid = String(GL.tournamentId || "").trim();
  const mine = mySessionKey();
  const now = Date.now();
  const bySeat = new Map();
  const byWaiting = new Map();

  for (const [key, entry] of Object.entries(staged)) {
    if (!entry || typeof entry !== "object" || key === mine) continue;
    if (entryAgeMs(entry, now) > STALE_MS) continue;
    const entryTid = String(entry.tournamentId || "").trim();
    if (entryTid && tid && entryTid !== tid) continue;
    const uid = String(entry.uid || key.split("__")[0] || "").trim();
    const { displayName, color } = normalizeOperatorIdentity(uid, entry);
    const seats = entry.seats && typeof entry.seats === "object" ? entry.seats : {};
    for (const [seatId, s] of Object.entries(seats)) {
      const sid = String(seatId || "").trim();
      if (!sid) continue;
      const waitingId = String(s?.waitingId || "").trim();
      const name = String(s?.name || "").trim();
      const item = { key, uid, displayName, color, waitingId, name, seatId: sid };
      if (!bySeat.has(sid)) bySeat.set(sid, []);
      bySeat.get(sid).push(item);
      if (waitingId) {
        if (!byWaiting.has(waitingId)) byWaiting.set(waitingId, []);
        byWaiting.get(waitingId).push(item);
      }
    }
  }

  remoteBySeat = bySeat;
  remoteByWaiting = byWaiting;
  const nextFp = [...bySeat.entries()]
    .map(([sid, list]) => `${sid}:${list.map((i) => `${i.key}/${i.waitingId}/${i.name}/${i.color}`).join("+")}`)
    .sort()
    .join(",");
  if (nextFp !== remoteFingerprint) {
    remoteFingerprint = nextFp;
    onRemoteChange?.();
  }
}

function stopTimers() {
  if (opsPollTimer) clearTimeout(opsPollTimer);
  opsPollTimer = 0;
  if (reevaluateTimer) clearInterval(reevaluateTimer);
  reevaluateTimer = 0;
  syncHeartbeat(false);
}

function subscribe(tid) {
  if (unsubscribeDoc || tid !== watchTid) return;
  let first = true;
  unsubscribeDoc = onSnapshot(
    stagedDocRef(tid),
    { includeMetadataChanges: false },
    (snap) => {
      docLoaded = true;
      applyStagedDoc(snap.exists() ? snap.data() || {} : {}, snap.metadata || {}, first);
      first = false;
    },
    (err) => console.warn("operator staged watch error:", err?.code || err)
  );
  reevaluateTimer = window.setInterval(() => recomputeRemote(), REEVALUATE_MS);
}

/**
 * realtime.js 에서 토너먼트 구독 시작 때 호출. 관리자 화면에서만 실제로 구독한다
 * (근무자 화면엔 표시하지 않으므로 읽기 비용만 든다). 반환값은 stop.
 */
export function watchRemoteStagedSeats(tid, onChange) {
  const nextTid = String(tid || "").trim();
  // 다른 토너먼트로 바뀌면 이전 토너먼트의 임시 배치는 의미가 없다 — 지우고 문서의 내 항목도 정리
  if (watchTid && nextTid !== watchTid) {
    const key = mySessionKey();
    if (key && lastDocStaged?.[key]) void enqueueWrite(watchTid, key, {});
    GL.pendingSeatAssignments.clear();
    seenServerTs = new Map();
  }
  if (nextTid !== watchTid) {
    remoteBySeat = new Map();
    remoteByWaiting = new Map();
    remoteFingerprint = "";
    lastDocStaged = {};
  }
  watchTid = nextTid;
  onRemoteChange = onChange;
  docLoaded = false;

  const tryStart = () => {
    opsPollTimer = 0;
    if (watchTid !== nextTid || unsubscribeDoc) return;
    if (canManageGlobalLayoutOps()) subscribe(nextTid);
    else opsPollTimer = window.setTimeout(tryStart, OPS_POLL_MS);
  };
  tryStart();

  return () => {
    if (unsubscribeDoc) unsubscribeDoc();
    unsubscribeDoc = null;
    docLoaded = false;
    stopTimers();
  };
}

/** 다른 관리자가 이 seat 에 임시 배치해 둔 목록. canView 는 호출측에서 한 번 계산해 넘기면 된다. */
export function getRemoteStagedForSeat(seatId, canView = canManageGlobalLayoutOps()) {
  if (!canView) return [];
  return remoteBySeat.get(String(seatId || "").trim()) || [];
}

export function getRemoteStagedForWaiting(waitingId, canView = canManageGlobalLayoutOps()) {
  if (!canView) return [];
  return remoteByWaiting.get(String(waitingId || "").trim()) || [];
}

export function remoteStagedFingerprint(canView = canManageGlobalLayoutOps()) {
  return canView ? remoteFingerprint : "";
}

/**
 * 표시용 라벨. 기본 "홍길동 배치중" (여럿이면 "홍길동·김철수 배치중").
 * withName 이면 "홍길동 → 김딜러" — 이미 사람이 앉아 있는 seat 에서 누구를 넣으려는지 보여줄 때.
 */
export function remoteStagedLabel(list = [], { withName = false } = {}) {
  if (!list.length) return "";
  if (withName) {
    return list.map((i) => `${i.displayName} → ${i.name || "-"}`).join(" / ");
  }
  const names = [...new Set(list.map((i) => i.displayName))];
  return `${names.join("·")} 배치중`;
}

/**
 * 내가 임시 배치하려는 seat/대기자를 이미 다른 관리자가 잡아 두었으면 확인을 받는다.
 * 계속 진행해도 되면 true.
 */
export function confirmStageAgainstRemote(seatId, waiting) {
  const sid = String(seatId || "").trim();
  const seatList = getRemoteStagedForSeat(sid);
  const waitList = getRemoteStagedForWaiting(waiting?.id).filter((i) => i.seatId !== sid);
  if (!seatList.length && !waitList.length) return true;
  const seatLabel = (id) => {
    const s = (GL.globalSeats || []).find((x) => String(x?.seatId || "").trim() === id);
    const label = String(s?.label ?? s?.no ?? "").trim();
    return label ? `SEAT ${label}` : "다른 Seat";
  };
  const lines = [];
  for (const i of seatList) {
    lines.push(`· ${i.displayName} 님이 이 Seat에 "${i.name || "-"}" 을(를) 배치 중입니다.`);
  }
  for (const i of waitList) {
    lines.push(`· ${i.displayName} 님이 "${i.name || waiting?.name || "-"}" 을(를) ${seatLabel(i.seatId)}에 배치 중입니다.`);
  }
  return confirm(`다른 관리자가 배치 중입니다.\n\n${lines.join("\n")}\n\n그래도 진행할까요?`);
}

/** 내 항목 즉시 삭제 (페이지 닫기·로그아웃). 실패해도 STALE_MS 뒤 무시됨 */
function clearMyEntryNow() {
  const key = mySessionKey();
  const tid = watchTid;
  if (!key || !tid || !lastDocStaged?.[key]) return Promise.resolve();
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = 0;
  return enqueueWrite(tid, key, {});
}

try {
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    void clearMyEntryNow();
  });
  // bfcache 복귀·앱 전환 후 복귀 — pagehide 에서 지웠을 수 있으니 남은 임시 배치를 다시 올린다
  window.addEventListener("pageshow", (e) => {
    pageHidden = false;
    if (e.persisted && GL.pendingSeatAssignments.size > 0) publishMyStagedSeats({ immediate: true, force: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && GL.pendingSeatAssignments.size > 0) {
      publishMyStagedSeats({ immediate: true });
    }
  });
  // 로그아웃 직전(아직 로그인 상태일 때) 내 항목을 지운다 — js/auth.js logout() 이 기다려 준다
  window.hanPitBeforeLogoutHooks = window.hanPitBeforeLogoutHooks || [];
  window.hanPitBeforeLogoutHooks.push(() => clearMyEntryNow());
  onAuthStateChanged(auth, (user) => {
    if (user) return;
    // 로그아웃되면 쓸 수 없으니 로컬 상태만 정리
    GL.pendingSeatAssignments.clear();
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = 0;
    syncHeartbeat(false);
  });
} catch {
  /* noop */
}
