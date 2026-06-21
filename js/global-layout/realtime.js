import { db, auth } from "../firebase.js";
import {
  collection,
  doc,
  getDocsFromServer,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  buildAttendanceInactiveUidSet,
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

/** Firestore 전파 전 캐시 스냅샷이 방금 배치한 좌석을 비우는 것 방지 */
const RECENT_LOCAL_SEAT_MS = 12000;
let seatRecoverDebounceTimer = null;
let lastSeatsUiFingerprint = "";
let lastWaitingUiFingerprint = "";

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

function applyDealerAttendanceSnap(snap) {
  const docs = filterAttendanceDocsForTournament(snap.docs, GL.tournamentId);
  GL.attendanceInactiveUids = buildAttendanceInactiveUidSet(docs, GL.tournamentId);
  GL.attendanceFilterReady = true;

  GL.attendanceWaiting = filterAttendanceRowsForWaitingMerge(
    docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
  ).map(({ id: _id, ...rest }) => rest);

  bumpGlobalLayoutDataRevision();
  if (GL.activeTab === "wait") {
    scheduleGlobalLayoutRealtimeUi({ waiting: true });
  } else {
    scheduleGlobalLayoutRealtimeUi({ metaOnly: true });
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

  GL.globalSeats = mergedSeats;
  bumpGlobalLayoutDataRevision();
  prevSeatsRef.value = mergedSeats;

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

  if (seatsUiChanged) {
    scheduleGlobalLayoutRealtimeUi({ seats: true, seatPanel: true, waiting: true });
  }

  return { mergedSeats, removedOccupiedSeats, nextSeats };
}

async function refreshGlobalSeatsFromServer() {
  if (!GL.tournamentId || isFirestoreQuotaCoolingDown()) return;
  try {
    const snap = await getDocsFromServer(
      collection(db, "tournaments", GL.tournamentId, "global_seats")
    );
    applyGlobalSeatsFromSnapshot(snap, { value: GL.globalSeats });
    scheduleGlobalLayoutRealtimeUi({ seats: true, seatPanel: true, waiting: true });
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshGlobalSeatsFromServer:", err?.code || err);
  }
}

export { disposeGlobalLayoutRealtime };

export function bindRealtime() {
  if (!GL.tournamentId) {
    alert("대회 정보가 없습니다.");
    location.replace("./index.html");
    return;
  }

  sessionStorage.setItem("tournamentId", GL.tournamentId);
  disposeGlobalLayoutRealtime();
  GL.attendanceFilterReady = false;
  GL.attendanceInactiveUids = new Set();
  GL.attendanceWaiting = [];
  lastSeatsUiFingerprint = "";
  lastWaitingUiFingerprint = "";

  let prevSeats = [];
  const prevSeatsRef = { value: prevSeats };

  void refreshGlobalSeatsFromServer();

  GL.stopSeatWatch = onSnapshot(
    collection(db, "tournaments", GL.tournamentId, "global_seats"),
    (snap) => {
      if (GL.seatMutationInFlight) return;
      if (shouldIgnoreStaleGlobalLayoutSnapshot(snap)) return;
      if (snap.empty && snap.metadata?.fromCache && GL.globalSeats.length > 0) {
        return;
      }
      const { removedOccupiedSeats, nextSeats } = applyGlobalSeatsFromSnapshot(snap, prevSeatsRef);
      prevSeats = prevSeatsRef.value;

      if (snap?.empty && !GL.globalSeats.length) {
        void refreshGlobalSeatsFromServer();
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
      if (GL.seatMutationInFlight || GL.waitingMutationInFlight) return;
      if (shouldIgnoreStaleGlobalLayoutSnapshot(snap)) return;
      const data = snap.exists() ? snap.data() || {} : {};
      const nextWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      const waitingFp = globalWaitingUiFingerprint(nextWaiting);
      const waitingUiChanged = waitingFp !== lastWaitingUiFingerprint;
      lastWaitingUiFingerprint = waitingFp;

      GL.globalWaiting = nextWaiting;
      applyOperatorPicksFromDoc(data, snap.metadata || {});
      bumpGlobalLayoutDataRevision();
      updateGlobalLayoutWaitingMeta();
      if (waitingUiChanged) {
        scheduleGlobalLayoutRealtimeUi({ waiting: true });
      }
    },
    (err) => logFirestoreWatchError("global waiting watch error", err)
  );

  GL.stopAttendanceWatch = onSnapshot(
    dealerAttendanceQueryForTournament(GL.tournamentId),
    applyDealerAttendanceSnap,
    (err) => {
      logFirestoreWatchError("dealer attendance watch error", err);
      GL.attendanceWaiting = [];
      GL.attendanceFilterReady = true;
      bumpGlobalLayoutDataRevision();
      scheduleGlobalLayoutRealtimeUi({ metaOnly: true });
    }
  );
}
