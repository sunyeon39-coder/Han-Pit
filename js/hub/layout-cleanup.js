import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import { runSerializedGlobalWaitingWrite } from "../global-layout/global-waiting-write-lock.js";

const LAYOUT_EVENTS_REF = collection(db, "layout_events");
const GLOBAL_WAITING_REF = doc(db, "layout_shared", "global_waiting");

export async function removeUserFromEventWaiting(user, selectedTournamentId = "") {
  if (!user) return 0;

  const targetUid = String(user.uid || "").trim();
  const targetName = String(user.nickname || "").trim();
  const tournamentId = String(selectedTournamentId || "").trim();

  if (!targetUid && !targetName) return 0;

  try {
    let removedCount = 0;

    await runSerializedGlobalWaitingWrite(() => runFirestoreTransactionWithRetry(db, async (tx) => {
      const snap = await tx.get(GLOBAL_WAITING_REF);
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const waiting = Array.isArray(data.waiting) ? data.waiting : [];
      if (!waiting.length) return;

      const nextWaiting = waiting.filter((item) => {
        if (!item || typeof item !== "object") return false;

        const itemUid = String(item.uid || "").trim();
        const itemName = String(item.name || "").trim();
        const itemTournamentId = String(item.tournamentId || "").trim();

        if (tournamentId && itemTournamentId && itemTournamentId !== tournamentId) {
          return true;
        }

        if (targetUid && itemUid && itemUid === targetUid) {
          removedCount += 1;
          return false;
        }

        if (!targetUid && targetName && itemName === targetName) {
          removedCount += 1;
          return false;
        }

        return true;
      });

      if (removedCount > 0) {
        tx.set(
          GLOBAL_WAITING_REF,
          {
            ...data,
            version: 2,
            waiting: nextWaiting,
            updatedAt: Date.now()
          },
          { merge: true }
        );
      }
    }));

    return removedCount;
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

export async function cleanupUserFromLayoutState(user, tournamentId = "") {
  const waitingRemoved = await removeUserFromEventWaiting(user, tournamentId);
  const seatRemoved = await removeUserFromAllSeats(user, tournamentId);

  return {
    waitingRemoved,
    seatRemoved
  };
}
