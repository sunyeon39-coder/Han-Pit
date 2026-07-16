import { db, auth } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  buildAttendanceInactiveUidSet,
  buildCheckedOutAttendanceUidSet,
  filterAttendanceRowsForWaitingMerge
} from "../shared/attendance-waiting-filter.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";
import { GL } from "./state.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { applyOperatorPicksFromDoc } from "./waiting-picks.js";
import { getAttendanceRef, isEmptyPerson, dedupeGlobalSeats, normalizeGlobalSeatFromFirestore, parseGlobalSeatDocIdParts, getGlobalSeatRowKey, getGlobalSeatSeatedAtMs } from "./utils.js";
import { rebuildWaitingAfterSeatToWait, waitingRowMatchesPerson } from "./fs-waiting-merge.js";
import {
  bumpGlobalLayoutDataRevision,
  scheduleGlobalLayoutRealtimeUi
} from "./realtime-ui.js";
import {
  shouldIgnoreStaleGlobalLayoutSnapshot,
  shouldSkipSeatRecoveryNow
} from "./layout-mutation-guard.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  triggerOptimisticMobileSeatAssignedAlert
} from "../shared/optimistic-seat-assigned-notify.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";
import { runFirestoreReadWithRetry } from "../shared/firestore-read-retry.js";
import { raceFirestoreTimeout } from "../shared/load-user-profile.js";
import { showFirestoreStallBanner } from "../shared/firestore-stall-recovery.js";
import { writeGlobalSeatsCache } from "./global-seats-session-cache.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { buildSeatHistoryEntry, appendSeatHistoryPatch } from "./seat-history.js";
import {
  purgeInactiveFromGlobalWaitingRows,
  buildMissingGlobalWaitingRestoreList,
  personExistsInGlobalWaiting,
  isPersonSeatedInGlobalSeats
} from "../shared/tournament-waiting-queue.js";
import { invalidateWaitingPanelFingerprint } from "./panel-ui.js";
import { resolveAttendanceWaitingJoinMs } from "../shared/attendance-operational-day.js";
import { mergeIncomingGlobalWaiting, replaceGlobalWaitingLocal } from "./waiting.js";
import { dedupeGlobalWaitingRows } from "../shared/tournament-waiting-queue.js";
import { isWaitingBlockSavePending } from "./fs-waiting-list-undo.js";
import {
  isGlobalWaitingWriteInFlight,
  runSerializedGlobalWaitingWrite
} from "./global-waiting-write-lock.js";

/** Firestore 전파 전 캐시 스냅샷이 방금 배치한 좌석을 비우는 것 방지 */
const RECENT_LOCAL_SEAT_MS = 12000;
let seatRecoverDebounceTimer = null;
let purgeInactiveWaitingTimer = null;
let restoreMissingWaitingTimer = null;
/** 출석 스냅샷 보관 — global_waiting 도착 후 inactive 재계산용 */
let attendanceInactiveSourceDocs = [];
let lastSeatsUiFingerprint = "";
let lastWaitingUiFingerprint = "";
let seatSnapshotReceived = false;
/** 서버 기준 좌석 동기화 완료(또는 서버에 좌석 0건 확인) */
let globalSeatsServerSynced = false;

/** 좌석 onSnapshot 이 한 번이라도 콜백을 받았는지 — 캐시 멈춤(hang) 감지용 */
export function hasReceivedGlobalSeatsSnapshot() {
  return seatSnapshotReceived;
}

export function hasGlobalSeatsServerSynced() {
  return globalSeatsServerSynced;
}

function globalSeatsUiFingerprint(seats = []) {
  return seats
    .map((s) =>
      [
        String(s?.seatId || "").trim(),
        String(s?.person || "").trim(),
        String(s?.personUid || "").trim(),
        String(s?.label ?? s?.no ?? ""),
        Number(s?.seatedAt || 0) || 0,
        Number(s?.order || 0) || 0,
        String(s?.status || "")
      ].join(":")
    )
    .join("|");
}

function globalWaitingUiFingerprint(arr = []) {
  return arr
    .map((w) =>
      [
        String(w?.id || "").trim(),
        String(w?.name || "").trim(),
        String(w?.uid || "").trim(),
        w?.blockChecked === true ? 1 : 0,
        Number(w?.joinedAt || w?.createdAt || 0) || 0,
        Number(w?.blockAccumulatedMs || 0) || 0
      ].join(":")
    )
    .join("|");
}

function disposeGlobalLayoutRealtime() {
  if (GL.stopSeatWatch) {
    GL.stopSeatWatch();
    GL.stopSeatWatch = null;
  }
  if (GL.stopWaitingWatch) {
    GL.stopWaitingWatch();
    GL.stopWaitingWatch = null;
  }
  if (GL.stopAttendanceWatch) {
    GL.stopAttendanceWatch();
    GL.stopAttendanceWatch = null;
  }
  if (seatRecoverDebounceTimer) {
    clearTimeout(seatRecoverDebounceTimer);
    seatRecoverDebounceTimer = null;
  }
  if (purgeInactiveWaitingTimer) {
    clearTimeout(purgeInactiveWaitingTimer);
    purgeInactiveWaitingTimer = null;
  }
  if (restoreMissingWaitingTimer) {
    clearTimeout(restoreMissingWaitingTimer);
    restoreMissingWaitingTimer = null;
  }
}

function scheduleRecoverRemovedSeatPeople(removedSeats, currentSeats) {
  if (seatRecoverDebounceTimer) clearTimeout(seatRecoverDebounceTimer);
  seatRecoverDebounceTimer = setTimeout(() => {
    seatRecoverDebounceTimer = null;
    void recoverRemovedSeatPeopleToWaiting(removedSeats, currentSeats).catch((err) => {
      console.error("recoverRemovedSeatPeopleToWaiting error:", err);
    });
  }, 600);
}

function rebuildGlobalLayoutAttendanceInactiveUids() {
  if (!GL.tournamentId) return;
  GL.attendanceInactiveUids = buildAttendanceInactiveUidSet(
    attendanceInactiveSourceDocs,
    GL.tournamentId,
    GL.globalWaiting
  );
  GL.attendanceCheckedOutUids = buildCheckedOutAttendanceUidSet(
    attendanceInactiveSourceDocs,
    GL.tournamentId
  );
  GL._waitingListCache = null;
  GL._waitingListCacheRev = -1;
  GL._waitingPanelFp = null;
}

function purgeSeatedPeopleFromGlobalWaitingLocal() {
  if (!Array.isArray(GL.globalWaiting) || !GL.globalWaiting.length) return false;
  const next = GL.globalWaiting.filter(
    (w) =>
      !isPersonSeatedInGlobalSeats(GL.globalSeats, {
        uid: w?.uid,
        email: w?.email,
        name: w?.name
      })
  );
  if (next.length === GL.globalWaiting.length) return false;
  GL.globalWaiting = next;
  GL._waitingListCache = null;
  GL._waitingListCacheRev = -1;
  invalidateWaitingPanelFingerprint();
  return true;
}

function applyDealerAttendanceSnap(snap) {
  if (
    snap.empty &&
    snap.metadata?.fromCache &&
    (attendanceInactiveSourceDocs.length > 0 || GL.attendanceWaiting.length > 0)
  ) {
    return;
  }

  const docs = filterAttendanceDocsForTournament(snap.docs, GL.tournamentId);
  attendanceInactiveSourceDocs = docs;
  GL.attendanceFilterReady = true;
  rebuildGlobalLayoutAttendanceInactiveUids();

  GL.attendanceWaiting = filterAttendanceRowsForWaitingMerge(
    docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
  ).map(({ id: _id, ...rest }) => rest);

  bumpGlobalLayoutDataRevision();
  scheduleGlobalLayoutRealtimeUi({ waiting: true });
  scheduleHealInactiveOutOfGlobalWaiting();
  scheduleHealMissingWaitingFromAttendance();
}

function scheduleHealInactiveOutOfGlobalWaiting() {
  if (!GL.tournamentId || !GL.attendanceFilterReady) return;
  if (!canManageGlobalLayoutOps()) return;
  if (purgeInactiveWaitingTimer) clearTimeout(purgeInactiveWaitingTimer);
  purgeInactiveWaitingTimer = setTimeout(() => {
    purgeInactiveWaitingTimer = null;
    void healInactiveRowsOutOfGlobalWaiting();
  }, 600);
}

async function healInactiveRowsOutOfGlobalWaiting() {
  if (!GL.tournamentId || GL.waitingMutationInFlight || isWaitingBlockSavePending()) return;
  if (isGlobalWaitingWriteInFlight()) return;
  const checkedOut = buildCheckedOutAttendanceUidSet(attendanceInactiveSourceDocs, GL.tournamentId);
  if (!checkedOut.size) return;

  const localNext = purgeInactiveFromGlobalWaitingRows(
    GL.globalWaiting,
    checkedOut,
    GL.tournamentId
  );
  if (localNext.length === (GL.globalWaiting || []).length) return;

  try {
    const waitingRef = doc(db, "layout_shared", "global_waiting");
    const snap = await getDoc(waitingRef);
    if (!snap.exists()) return;
    const state = snap.data() || {};
    const list = Array.isArray(state.waiting) ? state.waiting : [];
    const healed = purgeInactiveFromGlobalWaitingRows(list, checkedOut, GL.tournamentId);
    if (healed.length === list.length) return;

    GL.waitingMutationInFlight = true;
    await runSerializedGlobalWaitingWrite(async () => {
      await setDoc(
        waitingRef,
        {
          ...state,
          version: 2,
          waiting: healed,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    });
    replaceGlobalWaitingLocal(mergeIncomingGlobalWaiting(healed, GL.globalWaiting));
    bumpGlobalLayoutDataRevision();
    scheduleGlobalLayoutRealtimeUi({ waiting: true });
  } catch (err) {
    console.warn("healInactiveRowsOutOfGlobalWaiting:", err?.code || err);
  } finally {
    GL.waitingMutationInFlight = false;
  }
}

function scheduleHealMissingWaitingFromAttendance() {
  if (!GL.tournamentId || !GL.attendanceFilterReady) return;
  if (Date.now() < (GL.localMutationUntil || 0)) return;
  if (restoreMissingWaitingTimer) clearTimeout(restoreMissingWaitingTimer);
  restoreMissingWaitingTimer = setTimeout(() => {
    restoreMissingWaitingTimer = null;
    void healMissingWaitingFromAttendance();
  }, 1200);
}

export { scheduleHealMissingWaitingFromAttendance };

/** 출석 문서에 waiting 이 있는데 global_waiting 에 없으면 복구 (운영자·일반 유저 공통) */
async function healMissingWaitingFromAttendance() {
  if (!GL.tournamentId || GL.waitingMutationInFlight || !GL.attendanceFilterReady) return;
  if (Date.now() < (GL.localMutationUntil || 0)) return;
  if (isWaitingBlockSavePending() || isGlobalWaitingWriteInFlight()) return;

  const checkedOut = buildCheckedOutAttendanceUidSet(attendanceInactiveSourceDocs, GL.tournamentId);
  const missing = buildMissingGlobalWaitingRestoreList({
    tournamentId: GL.tournamentId,
    globalWaiting: GL.globalWaiting,
    globalSeats: GL.globalSeats,
    attendanceWaitingRows: GL.attendanceWaiting,
    terminalUids: checkedOut,
    resolveJoinedAt: (row) => resolveAttendanceWaitingJoinMs(row, Date.now())
  });

  if (!missing.length) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  try {
    GL.waitingMutationInFlight = true;
    let healed = null;
    await runSerializedGlobalWaitingWrite(() =>
      runFirestoreTransactionWithRetry(db, async (tx) => {
      const waitingSnap = await tx.get(waitingRef);
      const waitingData = waitingSnap.exists()
        ? waitingSnap.data() || {}
        : { version: 2, waiting: [], updatedAt: Date.now() };
      let waitingArr = Array.isArray(waitingData.waiting) ? [...waitingData.waiting] : [];
      const now = Date.now();
      let changed = false;

      for (const person of missing) {
        const uid = String(person?.uid || "").trim();
        if (uid && checkedOut.has(uid)) continue;
        if (personExistsInGlobalWaiting(waitingArr, GL.tournamentId, person)) continue;
        const joinMs = Number(person.joinedAt || 0) || now;
        waitingArr = rebuildWaitingAfterSeatToWait(waitingArr, GL.tournamentId, person, joinMs, {
          source: "attendance_restore",
          ...(person.uid ? { id: `w_${person.uid}` } : {})
        });
        changed = true;
      }
      if (!changed) return;

      waitingArr = dedupeGlobalWaitingRows(waitingArr, GL.tournamentId);
      healed = waitingArr;
      tx.set(
        waitingRef,
        {
          ...waitingData,
          version: 2,
          waiting: waitingArr,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    })
    );

    if (healed) {
      console.info(
        "[healMissingWaitingFromAttendance] restored",
        missing.length,
        "row(s) for",
        GL.tournamentId
      );
      replaceGlobalWaitingLocal(
        mergeIncomingGlobalWaiting(healed, GL.globalWaiting)
      );
      bumpGlobalLayoutDataRevision();
      scheduleGlobalLayoutRealtimeUi({ waiting: true });
    }
  } catch (err) {
    console.warn("healMissingWaitingFromAttendance:", err?.code || err);
  } finally {
    GL.waitingMutationInFlight = false;
  }
}

function shouldKeepLocalSeatOverRemoteEmpty(prevSeat, nextSeat) {
  const prevName = String(prevSeat?.person || "").trim();
  const nextName = String(nextSeat?.person || "").trim();
  if (isEmptyPerson(prevName) || !isEmptyPerson(nextName)) return false;
  const seatedAt = getGlobalSeatSeatedAtMs(prevSeat);
  if (!seatedAt) return false;
  return Date.now() - seatedAt < RECENT_LOCAL_SEAT_MS;
}

function mergeGlobalSeatsFromSnapshot(prevSeats = [], nextSeats = []) {
  const prevById = new Map();
  for (const seat of prevSeats) {
    const sid = String(seat?.seatId || "").trim();
    if (sid) prevById.set(sid, seat);
  }
  return nextSeats.map((next) => {
    const sid = String(next?.seatId || "").trim();
    const prev = sid ? prevById.get(sid) : null;
    if (!prev || !shouldKeepLocalSeatOverRemoteEmpty(prev, next)) return next;
    return {
      ...next,
      person: prev.person,
      personUid: prev.personUid,
      personEmail: prev.personEmail,
      seatedAt: prev.seatedAt,
      status: prev.status || next.status || "occupied"
    };
  });
}

function personIdentityKey(person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || "").trim();
  if (uid) return `uid:${uid}`;
  if (email) return `email:${email}`;
  if (name) return `name:${name}`;
  return "";
}

function isPersonStillSeated(seats = [], person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || "").trim();
  return seats.some((s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    const sUid = String(s?.personUid || "").trim();
    const sEmail = String(s?.personEmail || "").trim().toLowerCase();
    const sName = String(s?.person || "").trim();
    if (uid && sUid && uid === sUid) return true;
    if (email && sEmail && email === sEmail) return true;
    if (!uid && !email && name && sName === name) return true;
    return false;
  });
}

async function recoverRemovedSeatPeopleToWaiting(removedSeats = [], currentSeats = []) {
  if (!GL.tournamentId || !Array.isArray(removedSeats) || !removedSeats.length) return;
  const people = [];
  const seen = new Set();
  for (const seat of removedSeats) {
    const person = {
      uid: String(seat?.personUid || "").trim(),
      email: String(seat?.personEmail || "").trim(),
      name: String(seat?.person || "").trim()
    };
    if (isEmptyPerson(person.name)) continue;
    const key = personIdentityKey(person);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isPersonStillSeated(currentSeats, person)) continue;
    people.push(person);
  }
  if (!people.length) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const now = Date.now();
  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const waitingSnap = await tx.get(waitingRef);
    const waitingData = waitingSnap.exists() ? waitingSnap.data() || {} : {};
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
    let nextWaiting = waitingArr;
    for (const p of people) {
      if (waitingArr.some((w) => waitingRowMatchesPerson(w, GL.tournamentId, p))) continue;
      nextWaiting = rebuildWaitingAfterSeatToWait(nextWaiting, GL.tournamentId, p, now, {
        source: "seat_removed_recovery"
      });
      if (!p.uid) continue;
      tx.set(
        getAttendanceRef(db, GL.tournamentId, p.uid),
        {
          uid: p.uid,
          email: p.email,
          name: p.name,
          tournamentId: GL.tournamentId,
          status: "waiting",
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
    tx.set(
      waitingRef,
      {
        ...waitingData,
        version: 2,
        waiting: nextWaiting,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  });
}

function seatPersonIsSame(prev, next) {
  const pUid = String(prev?.personUid || "").trim();
  const nUid = String(next?.personUid || "").trim();
  if (pUid && nUid) return pUid === nUid;
  const pEmail = String(prev?.personEmail || "").trim().toLowerCase();
  const nEmail = String(next?.personEmail || "").trim().toLowerCase();
  if (pEmail && nEmail) return pEmail === nEmail;
  const pName = String(prev?.person || "").trim();
  const nName = String(next?.person || "").trim();
  return !!pName && pName === nName;
}

function seatHistoryEntryMatches(a, b) {
  const aUid = String(a?.personUid || "").trim();
  const bUid = String(b?.personUid || "").trim();
  const aName = String(a?.person || "").trim();
  const bName = String(b?.person || "").trim();
  const samePerson = aUid && bUid ? aUid === bUid : !!aName && aName === bName;
  if (!samePerson) return false;
  const aSeated = Number(a?.seatedAt) || 0;
  const bSeated = Number(b?.seatedAt) || 0;
  // 같은 사람의 같은 착석 구간이면(±3s) 동일 항목으로 간주 → 중복 기록 방지
  return Math.abs(aSeated - bSeated) < 3000;
}

/**
 * 좌석 점유자가 바뀌었는데(비우기·교체·이동 등) 어떤 쓰기 경로가 seatHistory 를
 * 남기지 못한 경우를 스냅샷 비교로 감지해 누락분만 채운다. 이미 기록된 항목은 건너뛴다.
 */
function detectSeatHistoryGaps(prevSeats, nextBySeatId, now) {
  const gaps = [];
  for (const prev of prevSeats || []) {
    const sid = String(prev?.seatId || "").trim();
    if (!sid) continue;
    const next = nextBySeatId.get(sid);
    if (!next) continue;
    const prevName = String(prev.person || "").trim();
    if (isEmptyPerson(prevName)) continue;
    if (seatPersonIsSame(prev, next)) continue;

    const nextName = String(next.person || "").trim();
    const reason = isEmptyPerson(nextName) ? "clear" : "replace";
    const entry = buildSeatHistoryEntry({
      person: prevName,
      personUid: prev.personUid,
      personEmail: prev.personEmail,
      seatedAt: getGlobalSeatSeatedAtMs(prev) || Number(prev.seatedAt) || 0,
      leftAt: now,
      reason
    });
    if (!entry) continue;

    const existing = Array.isArray(next.seatHistory) ? next.seatHistory : [];
    if (existing.some((h) => seatHistoryEntryMatches(h, entry))) continue;

    const docId = String(next.__firestoreDocId || "").trim();
    if (!docId) continue;
    gaps.push({ docId, entry });
  }
  return gaps;
}

async function persistSeatHistoryGaps(gaps) {
  if (!gaps?.length || !GL.tournamentId) return;
  for (const gap of gaps) {
    const ref = doc(db, "tournaments", GL.tournamentId, "global_seats", gap.docId);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const data = snap.data() || {};
        const existing = Array.isArray(data.seatHistory) ? data.seatHistory : [];
        if (existing.some((h) => seatHistoryEntryMatches(h, gap.entry))) return;
        const next = appendSeatHistoryPatch(existing, gap.entry);
        if (!next) return;
        tx.set(ref, { seatHistory: next }, { merge: true });
      });
    } catch (err) {
      console.warn("persistSeatHistoryGaps:", err?.code || err);
    }
  }
}

function logFirestoreWatchError(label, err) {
  const code = String(err?.code || "").trim();
  if (code === "already-exists") {
    console.warn(`${label}: listener target conflict (${code})`);
    return;
  }
  console.error(`${label}:`, err);
}

function applyGlobalSeatsFromSnapshot(snap, prevSeatsRef = { value: [] }) {
  const nextSeats = dedupeGlobalSeats(
    (snap?.docs || []).map((d) => normalizeGlobalSeatFromFirestore(d.data() || {}, d.id))
  );
  const mergedSeats = mergeGlobalSeatsFromSnapshot(GL.globalSeats, nextSeats);
  const nextSeatIds = new Set(
    mergedSeats.map((s) => String(s?.seatId || "").trim()).filter(Boolean)
  );
  const nextBySeatId = new Map(
    nextSeats.map((s) => [String(s?.seatId || "").trim(), s])
  );
  const removedOccupiedSeats = prevSeatsRef.value.filter((s) => {
    const sid = String(s?.seatId || "").trim();
    if (!sid || !nextSeatIds.has(sid)) return false;
    const next = nextBySeatId.get(sid);
    if (!next) return false;
    const prevName = String(s?.person || "").trim();
    const nextName = String(next?.person || "").trim();
    return !isEmptyPerson(prevName) && isEmptyPerson(nextName);
  });

  const historyGaps = prevSeatsRef.value.length
    ? detectSeatHistoryGaps(prevSeatsRef.value, nextBySeatId, Date.now())
    : [];

  const prevCount = prevSeatsRef.value?.length || 0;

  GL.globalSeats = mergedSeats;
  const purgedSeatedWaiting = purgeSeatedPeopleFromGlobalWaitingLocal();
  bumpGlobalLayoutDataRevision();
  prevSeatsRef.value = mergedSeats;
  if (!snap?.metadata?.fromCache || mergedSeats.length) {
    writeGlobalSeatsCache(GL.tournamentId, mergedSeats);
  }
  if (!snap?.metadata?.fromCache) {
    globalSeatsServerSynced = true;
  }

  const seatsFp = globalSeatsUiFingerprint(mergedSeats);
  const seatsUiChanged = seatsFp !== lastSeatsUiFingerprint;
  lastSeatsUiFingerprint = seatsFp;

  if (layoutIsMobile()) {
    maybeShowOptimisticSeatAlertFromSeats(mergedSeats, {
      user: GL.currentUser || auth.currentUser,
      profile: GL.userProfile,
      buildTargetUrl: (eventId, boxId, seatId) =>
        `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(seatId)}`,
      showAlert: (payload) => triggerOptimisticMobileSeatAssignedAlert(payload)
    });
  }

  if (seatsUiChanged || purgedSeatedWaiting || (mergedSeats.length > 0 && prevCount === 0)) {
    scheduleGlobalLayoutRealtimeUi({ seats: true, seatPanel: true, waiting: true });
  }

  return { mergedSeats, removedOccupiedSeats, nextSeats, historyGaps };
}

async function refreshGlobalWaitingFromServer() {
  if (isFirestoreQuotaCoolingDown()) return;
  if (GL.waitingMutationInFlight) return;
  try {
    const snap = await getDocFromServer(doc(db, "layout_shared", "global_waiting"));
    const data = snap.exists() ? snap.data() || {} : {};
    const nextWaiting = mergeIncomingGlobalWaiting(
      Array.isArray(data.waiting) ? data.waiting : [],
      GL.globalWaiting
    );
    GL.globalWaiting = nextWaiting;
    purgeSeatedPeopleFromGlobalWaitingLocal();
    applyOperatorPicksFromDoc(data, snap.metadata || {});
    bumpGlobalLayoutDataRevision();
    lastWaitingUiFingerprint = globalWaitingUiFingerprint(nextWaiting);
    updateGlobalLayoutWaitingMeta();
    scheduleGlobalLayoutRealtimeUi({ waiting: true, seatPanel: true });
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshGlobalWaitingFromServer:", err?.code || err);
  }
}

const GLOBAL_SEATS_SERVER_FETCH_MS = 10000;

function globalSeatsCollectionRef() {
  return collection(db, "tournaments", GL.tournamentId, "global_seats");
}

async function fetchGlobalSeatsSnapFromServer() {
  return runFirestoreReadWithRetry(
    () => getDocsFromServer(globalSeatsCollectionRef()),
    { maxAttempts: 2, baseDelayMs: 400 }
  );
}

async function fetchGlobalSeatsSnapFromCache() {
  return getDocs(globalSeatsCollectionRef());
}

async function refreshGlobalSeatsFromServer() {
  if (!GL.tournamentId) return;

  const applySnap = (snap, { fromServer = false } = {}) => {
    if (!snap) return false;
    applyGlobalSeatsFromSnapshot(snap, { value: GL.globalSeats });
    if (fromServer || !snap.metadata?.fromCache) {
      globalSeatsServerSynced = true;
    }
    scheduleGlobalLayoutRealtimeUi({ seats: true, seatPanel: true, waiting: true });
    return true;
  };

  if (!isFirestoreQuotaCoolingDown()) {
    try {
      const snap = await raceFirestoreTimeout(fetchGlobalSeatsSnapFromServer(), GLOBAL_SEATS_SERVER_FETCH_MS);
      if (snap) {
        applySnap(snap, { fromServer: true });
        return;
      }
      console.warn("refreshGlobalSeatsFromServer: server fetch timed out");
    } catch (err) {
      noteFirestoreQuotaExceeded(err);
      console.warn("refreshGlobalSeatsFromServer:", err?.code || err);
    }
  }

  try {
    const cacheSnap = await raceFirestoreTimeout(fetchGlobalSeatsSnapFromCache(), 4000);
    if (cacheSnap && !cacheSnap.empty) {
      applySnap(cacheSnap);
      return;
    }
  } catch (err) {
    console.warn("refreshGlobalSeatsFromServer cache:", err?.code || err);
  }

  if (!globalSeatsServerSynced && !GL.globalSeats.length) {
    showFirestoreStallBanner(
      "좌석 데이터를 불러오지 못했습니다(연결 지연). 연결 새로고침을 눌러 주세요."
    );
  }
}

export { disposeGlobalLayoutRealtime };

/** 세션 시작·캐시 공백 시 서버에서 대기·좌석을 한 번 더 읽음 */
export async function refreshGlobalLayoutOpsDataFromServer() {
  await Promise.all([refreshGlobalWaitingFromServer(), refreshGlobalSeatsFromServer()]);
}

export function bindRealtime() {
  if (!GL.tournamentId) {
    alert("대회 정보가 없습니다.");
    location.replace("./index.html");
    return;
  }

  sessionStorage.setItem("tournamentId", GL.tournamentId);
  disposeGlobalLayoutRealtime();
  GL.seatMutationInFlight = false;
  GL.waitingMutationInFlight = false;
  GL.localMutationUntil = 0;
  GL.pendingWaitingBlockByPerson = new Map();
  GL.attendanceFilterReady = false;
  GL.attendanceInactiveUids = new Set();
  GL.attendanceWaiting = [];
  attendanceInactiveSourceDocs = [];
  lastSeatsUiFingerprint = "";
  lastWaitingUiFingerprint = "";
  seatSnapshotReceived = false;
  globalSeatsServerSynced = false;

  let prevSeats = [];
  const prevSeatsRef = { value: prevSeats };

  // onSnapshot 첫 스냅샷이 곧 서버 데이터를 전달하고, 캐시가 비면 아래 fallback 이 서버를 읽으므로
  // 여기서 별도 getDocsFromServer 를 또 호출하지 않는다(중복 읽기로 Firestore quota 소모 방지).

  GL.stopSeatWatch = onSnapshot(
    collection(db, "tournaments", GL.tournamentId, "global_seats"),
    (snap) => {
      seatSnapshotReceived = true;
      if (GL.seatMutationInFlight && snap.metadata?.fromCache) return;
      if (shouldIgnoreStaleGlobalLayoutSnapshot(snap)) return;
      if (snap.empty && snap.metadata?.fromCache && GL.globalSeats.length > 0) {
        return;
      }
      const { removedOccupiedSeats, nextSeats, historyGaps } = applyGlobalSeatsFromSnapshot(
        snap,
        prevSeatsRef
      );
      prevSeats = prevSeatsRef.value;

      if (snap?.empty && !GL.globalSeats.length) {
        void refreshGlobalSeatsFromServer();
      }

      // 어떤 경로든 점유자가 바뀌었는데 이력이 누락된 경우, 권한 있는 클라이언트가 보강한다.
      if (
        historyGaps.length &&
        !snap.metadata?.fromCache &&
        !snap.metadata?.hasPendingWrites &&
        canManageGlobalLayoutOps()
      ) {
        void persistSeatHistoryGaps(historyGaps);
      }

      if (
        removedOccupiedSeats.length &&
        !shouldSkipSeatRecoveryNow() &&
        !snap.metadata?.fromCache &&
        !snap.metadata?.hasPendingWrites
      ) {
        scheduleRecoverRemovedSeatPeople(removedOccupiedSeats, nextSeats);
      }
    },
    (err) => {
      seatSnapshotReceived = true;
      logFirestoreWatchError("global seats watch error", err);
      if (String(err?.code || "").includes("permission-denied") && !GL.hasShownPermissionAlert) {
        GL.hasShownPermissionAlert = true;
        alert("global_seats 권한이 없습니다. Firestore Rules 배포 상태를 확인해주세요.");
      }
    }
  );

  GL.stopWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      if (shouldIgnoreStaleGlobalLayoutSnapshot(snap)) return;
      if (GL.waitingMutationInFlight) return;
      const data = snap.exists() ? snap.data() || {} : {};
      const nextWaiting = mergeIncomingGlobalWaiting(
        Array.isArray(data.waiting) ? data.waiting : [],
        GL.globalWaiting
      );
      lastWaitingUiFingerprint = globalWaitingUiFingerprint(nextWaiting);

      GL.globalWaiting = nextWaiting;
      purgeSeatedPeopleFromGlobalWaitingLocal();
      applyOperatorPicksFromDoc(data, snap.metadata || {});
      rebuildGlobalLayoutAttendanceInactiveUids();
      bumpGlobalLayoutDataRevision();
      updateGlobalLayoutWaitingMeta();
      scheduleGlobalLayoutRealtimeUi({ waiting: true, seatPanel: true });
      if (GL.attendanceFilterReady) {
        scheduleHealMissingWaitingFromAttendance();
      }

      if (
        snap.metadata?.fromCache &&
        (!snap.exists() || !nextWaiting.length)
      ) {
        void refreshGlobalWaitingFromServer();
      }
    },
    (err) => {
      logFirestoreWatchError("global waiting watch error", err);
      void refreshGlobalWaitingFromServer();
    }
  );

  GL.stopAttendanceWatch = onSnapshot(
    dealerAttendanceQueryForTournament(GL.tournamentId),
    applyDealerAttendanceSnap,
    (err) => {
      logFirestoreWatchError("dealer attendance watch error", err);
      if (!GL.attendanceWaiting.length) {
        GL.attendanceFilterReady = true;
      }
      bumpGlobalLayoutDataRevision();
      scheduleGlobalLayoutRealtimeUi({ waiting: true, metaOnly: true });
    }
  );

  void refreshGlobalSeatsFromServer();
}
