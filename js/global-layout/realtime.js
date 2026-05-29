import { db } from "../firebase.js";
import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { attendanceDocBelongsToTournament } from "../index/dealer-attendance-refs.js";
import { GL } from "./state.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { renderSeats, renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { applyOperatorPicksFromDoc } from "./waiting-picks.js";
import { getAttendanceRef, isEmptyPerson } from "./utils.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";

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

export function bindRealtime() {
  if (!GL.tournamentId) {
    alert("대회 정보가 없습니다.");
    location.replace("./index.html");
    return;
  }

  sessionStorage.setItem("tournamentId", GL.tournamentId);

  if (GL.stopSeatWatch) GL.stopSeatWatch();
  let prevSeats = [];
  GL.stopSeatWatch = onSnapshot(
    collection(db, "tournaments", GL.tournamentId, "global_seats"),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.empty && snap.metadata?.fromCache && GL.globalSeats.length > 0) {
        return;
      }
      const nextSeats = snap.docs.map((d) => ({
        ...(d.data() || {}),
        __firestoreDocId: d.id
      }));
      const nextSeatIds = new Set(nextSeats.map((s) => String(s?.seatId || "").trim()).filter(Boolean));
      const removedOccupiedSeats = prevSeats.filter((s) => {
        const sid = String(s?.seatId || "").trim();
        if (!sid || nextSeatIds.has(sid)) return false;
        return !isEmptyPerson(String(s?.person || "").trim());
      });

      GL.globalSeats = nextSeats;
      renderSeats(GL.globalSeats);
      if (GL.activeTab === "seat") renderSeatPanel();
      if (GL.activeTab === "wait") {
        renderWaiting(getCurrentTournamentWaiting());
      }
      prevSeats = nextSeats;

      if (removedOccupiedSeats.length) {
        void recoverRemovedSeatPeopleToWaiting(removedOccupiedSeats, nextSeats).catch((err) => {
          console.error("recoverRemovedSeatPeopleToWaiting error:", err);
        });
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
      const data = snap.exists() ? (snap.data() || {}) : {};
      GL.globalWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      applyOperatorPicksFromDoc(data);
      const filtered = getCurrentTournamentWaiting();
      updateGlobalLayoutWaitingMeta();
      renderWaiting(filtered);
    },
    (err) => console.error("global waiting watch error:", err)
  );

  if (GL.stopAttendanceWatch) GL.stopAttendanceWatch();
  GL.stopAttendanceWatch = onSnapshot(
    collection(db, "dealer_attendance"),
    (snap) => {
      const inactive = new Set();
      snap.docs.forEach((d) => {
        if (!attendanceDocBelongsToTournament(d.id, GL.tournamentId)) return;
        const data = d.data() || {};
        const uid = String(data.uid || "").trim();
        const status = String(data.status || "").trim();
        if (uid && (status === "checked_out" || status === "off")) inactive.add(uid);
      });
      GL.attendanceInactiveUids = inactive;

      GL.attendanceWaiting = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .filter((row) => {
          if (!attendanceDocBelongsToTournament(row.id, GL.tournamentId)) return false;
          const status = String(row.status || "").trim();
          return status === "waiting" || status === "checked_in";
        })
        .map(({ id: _id, ...rest }) => rest);

      renderWaiting(getCurrentTournamentWaiting());
    },
    (err) => {
      console.error("dealer attendance watch error:", err);
    }
  );
}
