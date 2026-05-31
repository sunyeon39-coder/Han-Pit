import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  buildAttendanceInactiveUidSet,
  filterAttendanceRowsForWaitingMerge
} from "../shared/attendance-waiting-filter.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";
import { GL } from "./state.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { applyOperatorPicksFromDoc } from "./waiting-picks.js";
import { getAttendanceRef, isEmptyPerson, getGlobalSeatSeatedAtMs } from "./utils.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
import {
  bumpGlobalLayoutDataRevision,
  scheduleGlobalLayoutRealtimeUi
} from "./realtime-ui.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  triggerOptimisticMobileSeatAssignedAlert
} from "../shared/optimistic-seat-assigned-notify.js";

/** Firestore 전파 전 캐시 스냅샷이 방금 배치한 좌석을 비우는 것 방지 */
const RECENT_LOCAL_SEAT_MS = 12000;
let seatRecoverDebounceTimer = null;

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
  await runTransaction(db, async (tx) => {
    const waitingSnap = await tx.get(waitingRef);
    const waitingData = waitingSnap.exists() ? waitingSnap.data() || {} : {};
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
    let nextWaiting = waitingArr;
    for (const p of people) {
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
  void primeDealerAttendanceFilter();

  let prevSeats = [];
  GL.stopSeatWatch = onSnapshot(
    collection(db, "tournaments", GL.tournamentId, "global_seats"),
    (snap) => {
      if (GL.seatMutationInFlight) return;
      if (snap.empty && snap.metadata?.fromCache && GL.globalSeats.length > 0) {
        return;
      }
      const nextSeats = snap.docs.map((d) => ({
        ...(d.data() || {}),
        __firestoreDocId: d.id
      }));
      const mergedSeats = mergeGlobalSeatsFromSnapshot(GL.globalSeats, nextSeats);
      const nextSeatIds = new Set(mergedSeats.map((s) => String(s?.seatId || "").trim()).filter(Boolean));
      const removedOccupiedSeats = prevSeats.filter((s) => {
        const sid = String(s?.seatId || "").trim();
        if (!sid || nextSeatIds.has(sid)) return false;
        return !isEmptyPerson(String(s?.person || "").trim());
      });

      GL.globalSeats = mergedSeats;
      bumpGlobalLayoutDataRevision();
      prevSeats = mergedSeats;

      if (layoutIsMobile()) {
        maybeShowOptimisticSeatAlertFromSeats(mergedSeats, {
          user: GL.currentUser || auth.currentUser,
          profile: GL.userProfile,
          buildTargetUrl: (eventId, boxId, seatId) =>
            `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(seatId)}`,
          showAlert: (payload) => triggerOptimisticMobileSeatAssignedAlert(payload)
        });
      }

      const flags = { seats: true, seatPanel: GL.activeTab === "seat" };
      if (GL.activeTab === "wait") flags.waiting = true;
      scheduleGlobalLayoutRealtimeUi(flags);

      if (
        removedOccupiedSeats.length &&
        !snap.metadata?.fromCache &&
        !snap.metadata?.hasPendingWrites
      ) {
        scheduleRecoverRemovedSeatPeople(removedOccupiedSeats, nextSeats);
      }
    },
    (err) => {
      console.error("global seats watch error:", err);
      if (String(err?.code || "").includes("permission-denied") && !GL.hasShownPermissionAlert) {
        GL.hasShownPermissionAlert = true;
        alert("global_seats 권한이 없습니다. Firestore Rules 배포 상태를 확인해주세요.");
      }
    }
  );

  if (GL.stopWaitingWatch) GL.stopWaitingWatch();
  GL.stopWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      if (GL.seatMutationInFlight) return;
      const data = snap.exists() ? snap.data() || {} : {};
      GL.globalWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      applyOperatorPicksFromDoc(data);
      bumpGlobalLayoutDataRevision();
      updateGlobalLayoutWaitingMeta();
      scheduleGlobalLayoutRealtimeUi(
        GL.activeTab === "wait" ? { waiting: true } : { metaOnly: true }
      );
    },
    (err) => console.error("global waiting watch error:", err)
  );

  GL.stopAttendanceWatch = onSnapshot(
    dealerAttendanceQueryForTournament(GL.tournamentId),
    applyDealerAttendanceSnap,
    (err) => {
      console.warn("dealer attendance watch error (대기 병합만 제한):", err?.code || err);
      GL.attendanceWaiting = [];
      GL.attendanceFilterReady = true;
      bumpGlobalLayoutDataRevision();
      scheduleGlobalLayoutRealtimeUi({ metaOnly: true });
    }
  );
}
