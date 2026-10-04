import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  globalWaitingCollectionRef,
  globalWaitingCollectionGroupRef
} from "../shared/tournament-waiting-queue.js";

const LAYOUT_EVENTS_REF = collection(db, "layout_events");

export async function removeUserFromEventWaiting(user, selectedTournamentId = "") {
  if (!user) return 0;

  const targetUid = String(user.uid || "").trim();
  const targetName = String(user.nickname || "").trim();
  const tournamentId = String(selectedTournamentId || "").trim();

  if (!targetUid && !targetName) return 0;

  try {
    const collRef = tournamentId
      ? globalWaitingCollectionRef(db, tournamentId)
      : globalWaitingCollectionGroupRef(db);

    const snaps = targetUid
      ? [await getDocs(query(collRef, where("uid", "==", targetUid)))]
      : [await getDocs(query(collRef, where("name", "==", targetName)))];

    const refsToDelete = new Map();
    for (const snap of snaps) {
      snap.docs.forEach((d) => refsToDelete.set(d.ref.path, d.ref));
    }

    if (!refsToDelete.size) return 0;

    const batch = writeBatch(db);
    for (const ref of refsToDelete.values()) batch.delete(ref);
    await batch.commit();

    return refsToDelete.size;
  } catch (err) {
    console.error("removeUserFromEventWaiting error:", err);
    return 0;
  }
}

export async function removeUserFromAllSeats(user, selectedTournamentId = "") {
  if (!user) return 0;

  const targetUid = String(user.uid || "").trim();
  const targetName = String(user.nickname || "").trim();
  const tournamentId = String(selectedTournamentId || "").trim();

  if (!targetUid && !targetName) return 0;

  let removedCount = 0;

  const snap = await getDocs(LAYOUT_EVENTS_REF);
  if (snap.empty) return 0;

  const batch = writeBatch(db);

  snap.forEach((d) => {
    const data = d.data() || {};

    if (tournamentId) {
      const itemTournamentId = String(data.tournamentId || "").trim();
      if (itemTournamentId && itemTournamentId !== tournamentId) {
        return;
      }
    }

    const seats = Array.isArray(data.seats) ? data.seats : [];
    let changed = false;

    const nextSeats = seats.map((seat) => {
      if (!seat || typeof seat !== "object") return seat;

      const person = String(seat.person || "").trim();
      const personUid = String(seat.personUid || "").trim();

      const uidMatched = targetUid && personUid && personUid === targetUid;
      const nameMatched = !targetUid && targetName && person === targetName;

      if (!uidMatched && !nameMatched) return seat;

      removedCount += 1;
      changed = true;

      return {
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      };
    });

    if (changed) {
      batch.set(
        d.ref,
        {
          seats: nextSeats,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    }
  });

  if (removedCount > 0) {
    await batch.commit();
  }

  return removedCount;
}

/**
 * 통합 배치도 정본(tournaments/{tid}/global_seats) 좌석에서도 뺀다 — 예전엔 layout_events(투영본)만
 * 비워서, 권한을 해제해도 통합 배치도엔 그 사람이 계속 앉아 있는 것으로 남았다.
 */
async function removeUserFromGlobalSeats(user, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const targetUid = String(user?.uid || "").trim();
  if (!tid || !targetUid) return 0;
  try {
    const snap = await getDocs(
      query(collection(db, "tournaments", tid, "global_seats"), where("personUid", "==", targetUid))
    );
    if (snap.empty) return 0;
    const now = Date.now();
    const batch = writeBatch(db);
    snap.docs.forEach((d) => {
      batch.set(
        d.ref,
        { person: "비어있음", personUid: "", personEmail: "", seatedAt: null, status: "empty", updatedAt: now },
        { merge: true }
      );
    });
    await batch.commit();
    return snap.size;
  } catch (err) {
    console.error("removeUserFromGlobalSeats error:", err);
    return 0;
  }
}

export async function cleanupUserFromLayoutState(user, tournamentId = "") {
  const waitingRemoved = await removeUserFromEventWaiting(user, tournamentId);
  const projectionRemoved = await removeUserFromAllSeats(user, tournamentId);
  const globalRemoved = await removeUserFromGlobalSeats(user, tournamentId);
  const seatRemoved = Math.max(projectionRemoved, globalRemoved);

  return {
    waitingRemoved,
    seatRemoved
  };
}
