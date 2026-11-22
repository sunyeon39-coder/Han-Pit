/**
 * "배치확인" 전 임시(staged) 배치를 다른 관리자 화면에도 보여준다.
 *
 * 임시 배치 자체(GL.pendingSeatAssignments)는 여전히 이 세션 로컬 상태이고 Firestore 좌석엔
 * 아무것도 쓰지 않는다. 다만 관리자 두 명이 동시에 같은 Seat(또는 같은 대기자)를 잡아 놓고
 * 서로 모른 채 배치확인을 누르는 실수가 잦아서, "누가 어느 Seat에 누구를 넣어두었는지"만
 * tournaments/{tid}/global_waiting_meta/operatorStaged 문서에 세션별로 올려 공유한다.
 *
 * 문서 모양: { staged: { "<uid>__<sessionId>": { uid, displayName, color, tournamentId,
 *   updatedAt, seats: { "<seatId>": { waitingId, name } } } } }
 * - 같은 계정으로 창을 두 개 열어도 서로 덮어쓰지 않게 세션 단위 키를 쓴다.
 * - 창을 그냥 닫아 지워지지 않은 항목은 STALE_MS 뒤 화면에서 무시되고, 다음 쓰기 때 정리된다.
 *   임시 배치가 남아 있는 동안은 HEARTBEAT_MS 마다 updatedAt 을 갱신한다.
 * - operatorPicks 문서는 좌석 배정 트랜잭션이 읽고 쓰므로, 충돌(재시도)을 피하려고 별도 문서를 쓴다.
 */
import { auth, db } from "../firebase.js";
import {
  doc,
  deleteField,
  FieldPath,
  onSnapshot,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { getOperatorDisplayName } from "./waiting-picks.js";
import { resolveLayoutAccentColor } from "../shared/layout-operator-colors.js";

const STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const PUBLISH_DEBOUNCE_MS = 120;

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

/** seatId → [{ key, uid, displayName, color, waitingId, name }] (내 세션 제외) */
let remoteBySeat = new Map();
/** waitingId → [{ key, uid, displayName, color, seatId }] (내 세션 제외) */
let remoteByWaiting = new Map();
let remoteFingerprint = "";
let lastDocStaged = {};

let publishTimer = 0;
let heartbeatTimer = 0;
let writeChain = Promise.resolve();
let lastPublishedKey = "";
let lastPublishedTid = "";
let onRemoteChange = null;

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
        seats
      }
    : deleteField();

  // 내 항목 + 오래 방치된 다른 세션 항목 정리. FieldPath 로 지정해야 uid 안의 문자가
  // 경로로 해석되지 않고, 맵 전체가 교체돼(merge 아님) 취소한 seat 이 남지 않는다.
  const args = [new FieldPath("staged", key), value];
  for (const [otherKey, entry] of Object.entries(lastDocStaged || {})) {
    if (otherKey === key) continue;
    if (now - Number(entry?.updatedAt || 0) > STALE_MS) {
      args.push(new FieldPath("staged", otherKey), deleteField());
    }
  }
  try {
    await updateDoc(ref, ...args);
  } catch (err) {
    if (err?.code !== "not-found") throw err;
    if (!hasSeats) return;
    await setDoc(ref, { staged: { [key]: value } }, { merge: true });
  }
}

/** 내 임시 배치가 바뀔 때마다 호출 — 디바운스 후 Firestore 에 반영 */
export function publishMyStagedSeats({ immediate = false } = {}) {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = 0;
  const run = () => {
    publishTimer = 0;
    const key = mySessionKey();
    const tid = String(GL.tournamentId || "").trim();
    if (!key || !tid || !canManageGlobalLayoutOps()) return;
    const seats = buildMySeatsMap();
    const fp = JSON.stringify(seats);
    const hasSeats = fp !== "{}";
    // 다른 토너먼트로 넘어갔다면 이전 토너먼트 쪽 내 항목부터 지운다
    if (lastPublishedTid && lastPublishedTid !== tid && lastPublishedKey !== "{}") {
      const prevTid = lastPublishedTid;
      writeChain = writeChain.then(() => writeMyEntry(prevTid, key, {})).catch(() => {});
      lastPublishedKey = "{}";
    }
    lastPublishedTid = tid;
    if (fp === lastPublishedKey && !immediate) return;
    if (!hasSeats && lastPublishedKey === "" && !lastDocStaged?.[key]) {
      lastPublishedKey = fp;
      return;
    }
    lastPublishedKey = fp;
    writeChain = writeChain
      .then(() => writeMyEntry(tid, key, seats))
      .catch((err) => {
        lastPublishedKey = "";
        console.warn("publishMyStagedSeats:", err?.code || err);
      });
    syncHeartbeat(hasSeats);
  };
  if (immediate) run();
  else publishTimer = window.setTimeout(run, PUBLISH_DEBOUNCE_MS);
}

function syncHeartbeat(active) {
  if (active && !heartbeatTimer) {
    heartbeatTimer = window.setInterval(() => publishMyStagedSeats({ immediate: true }), HEARTBEAT_MS);
  } else if (!active && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = 0;
  }
}

/** 새로고침 전 세션이 남긴 내 항목 정리 — 관리자 권한 확인이 끝나기 전이면 잠시 뒤 다시 시도 */
let leftoverCleanupTimer = 0;
function scheduleLeftoverCleanup(attempt = 0) {
  if (leftoverCleanupTimer) clearTimeout(leftoverCleanupTimer);
  leftoverCleanupTimer = 0;
  const key = mySessionKey();
  if (!key || !lastDocStaged?.[key] || GL.pendingSeatAssignments.size > 0) return;
  if (canManageGlobalLayoutOps()) {
    lastPublishedKey = "";
    publishMyStagedSeats({ immediate: true });
    return;
  }
  if (attempt < 20) {
    leftoverCleanupTimer = window.setTimeout(() => scheduleLeftoverCleanup(attempt + 1), 3000);
  }
}

function applyStagedDoc(data = {}) {
  const staged = data?.staged && typeof data.staged === "object" ? data.staged : {};
  lastDocStaged = staged;
  const tid = String(GL.tournamentId || "").trim();
  const mine = mySessionKey();
  const now = Date.now();
  const bySeat = new Map();
  const byWaiting = new Map();

  for (const [key, entry] of Object.entries(staged)) {
    if (!entry || typeof entry !== "object" || key === mine) continue;
    if (now - Number(entry.updatedAt || 0) > STALE_MS) continue;
    const entryTid = String(entry.tournamentId || "").trim();
    if (entryTid && tid && entryTid !== tid) continue;
    const uid = String(entry.uid || key.split("__")[0] || "").trim();
    const displayName = String(entry.displayName || "").trim() || uid.slice(0, 6) || "운영";
    const color = String(entry.color || "").trim() || resolveLayoutAccentColor({}, uid);
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

  // 내 세션 항목이 문서에 남아 있는데 지금 로컬엔 임시 배치가 없다면(새로고침 직후 등) 지운다
  if (mine && staged[mine] && GL.pendingSeatAssignments.size === 0 && lastPublishedKey !== "{}") {
    scheduleLeftoverCleanup();
  }

  remoteBySeat = bySeat;
  remoteByWaiting = byWaiting;
  const nextFp = [...bySeat.entries()]
    .map(([sid, list]) => `${sid}:${list.map((i) => `${i.key}/${i.waitingId}/${i.name}`).join("+")}`)
    .sort()
    .join(",");
  if (nextFp !== remoteFingerprint) {
    remoteFingerprint = nextFp;
    onRemoteChange?.();
  }
}

/** realtime.js 에서 토너먼트 구독 시작 때 호출. 반환값은 unsubscribe. */
export function watchRemoteStagedSeats(tid, onChange) {
  onRemoteChange = onChange;
  remoteBySeat = new Map();
  remoteByWaiting = new Map();
  remoteFingerprint = "";
  lastDocStaged = {};
  return onSnapshot(
    stagedDocRef(tid),
    (snap) => applyStagedDoc(snap.exists() ? snap.data() || {} : {}),
    (err) => console.warn("operator staged watch error:", err?.code || err)
  );
}

/** 다른 관리자가 이 seat 에 임시 배치해 둔 목록 (내 로컬 임시 배치가 있으면 그게 우선이라 호출측에서 처리) */
export function getRemoteStagedForSeat(seatId) {
  if (!canManageGlobalLayoutOps()) return [];
  return remoteBySeat.get(String(seatId || "").trim()) || [];
}

export function getRemoteStagedForWaiting(waitingId) {
  if (!canManageGlobalLayoutOps()) return [];
  return remoteByWaiting.get(String(waitingId || "").trim()) || [];
}

export function remoteStagedFingerprint() {
  return canManageGlobalLayoutOps() ? remoteFingerprint : "";
}

/** 표시용 라벨: "홍길동 배치중" (여럿이면 "홍길동·김철수 배치중") */
export function remoteStagedLabel(list = []) {
  const names = [...new Set(list.map((i) => i.displayName))];
  return names.length ? `${names.join("·")} 배치중` : "";
}

/**
 * 내가 임시 배치하려는 seat/대기자를 이미 다른 관리자가 잡아 두었으면 확인을 받는다.
 * 계속 진행해도 되면 true.
 */
export function confirmStageAgainstRemote(seatId, waiting) {
  const seatList = getRemoteStagedForSeat(seatId);
  const waitList = getRemoteStagedForWaiting(waiting?.id).filter(
    (i) => i.seatId !== String(seatId || "").trim()
  );
  if (!seatList.length && !waitList.length) return true;
  const lines = [];
  for (const i of seatList) {
    lines.push(`· ${i.displayName} 님이 이 Seat에 "${i.name || "-"}" 을(를) 배치 중입니다.`);
  }
  for (const i of waitList) {
    lines.push(`· ${i.displayName} 님이 "${i.name || waiting?.name || "-"}" 을(를) 다른 Seat에 배치 중입니다.`);
  }
  return confirm(`다른 관리자가 배치 중입니다.\n\n${lines.join("\n")}\n\n그래도 진행할까요?`);
}

/** 페이지를 닫을 때 내 임시 배치 표시를 최대한 지운다 (실패해도 STALE_MS 뒤 무시됨) */
export function clearMyStagedSeatsOnUnload() {
  const key = mySessionKey();
  const tid = String(GL.tournamentId || "").trim();
  if (!key || !tid || lastPublishedKey === "{}" || lastPublishedKey === "") return;
  lastPublishedKey = "{}";
  void writeMyEntry(tid, key, {}).catch(() => {});
}

try {
  window.addEventListener("pagehide", clearMyStagedSeatsOnUnload);
} catch {
  /* noop */
}
