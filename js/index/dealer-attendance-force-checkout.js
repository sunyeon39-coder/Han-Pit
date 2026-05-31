import { setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import {
  removeUserFromAllSeatsGlobal,
  removeFromSharedWaitingOnCheckOut,
  clearUserSeatNotification
} from "./dealer-attendance-waiting.js";
import {
  updateMyAttendanceStatus,
  updateAdminAttendanceStatus
} from "./dealer-attendance-status-updates.js";
import {
  applyOptimisticAttendanceEntry,
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";

function applyCheckedOutSeatClear(tournamentId, uid) {
  const docId = getAttendanceDocId(tournamentId, uid);
  const entry = IX.dealerAttendanceMap.get(docId);
  if (!entry) return;
  applyOptimisticAttendanceEntry(tournamentId, uid, {
    ...entry,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: "",
    updatedAt: Date.now()
  });
}

export async function forceAdminCheckedOut(target) {
  if (!target?.uid) return;

  const tournamentId = getTournamentId();
  const prevSnap = snapshotAttendanceEntry(tournamentId, target.uid);

  try {
    await updateAdminAttendanceStatus(target.uid, "checked_out", { optimistic: true });
    applyCheckedOutSeatClear(tournamentId, target.uid);
  } catch (err) {
    console.error("forceAdminCheckedOut status:", err);
    throw err;
  }

  void (async () => {
    try {
      await Promise.all([
        removeUserFromAllSeatsGlobal({ uid: target.uid }),
        removeFromSharedWaitingOnCheckOut({
          uid: target.uid,
          email: target.email || "",
          displayName: target.nickname || "",
          nickname: target.nickname || ""
        }),
        setDoc(
          getAttendanceRef(tournamentId, target.uid),
          {
            currentEventId: "",
            currentBoxId: "",
            currentSeatId: "",
            currentSeatLabel: "",
            updatedAt: Date.now()
          },
          { merge: true }
        ),
        clearUserSeatNotification(target.uid)
      ]);
    } catch (err) {
      console.error("forceAdminCheckedOut cleanup:", err);
      restoreAttendanceSnapshot(tournamentId, target.uid, prevSnap);
    }
  })();
}

export async function forceSelfCheckedOut(user) {
  if (!user?.uid) return;

  const tournamentId = getTournamentId();
  const targetProfile = IX.currentUserProfile || {};
  const prevSnap = snapshotAttendanceEntry(tournamentId, user.uid);

  try {
    await updateMyAttendanceStatus("checked_out", { optimistic: true });
    applyCheckedOutSeatClear(tournamentId, user.uid);
  } catch (err) {
    console.error("forceSelfCheckedOut status:", err);
    throw err;
  }

  void (async () => {
    try {
      await Promise.all([
        removeUserFromAllSeatsGlobal({ uid: user.uid }),
        removeFromSharedWaitingOnCheckOut({
          uid: user.uid,
          email: String(targetProfile.email || user.email || "").trim(),
          displayName: String(targetProfile.nickname || user.displayName || "").trim(),
          nickname: String(targetProfile.nickname || user.displayName || "").trim()
        }),
        setDoc(
          getAttendanceRef(tournamentId, user.uid),
          {
            currentEventId: "",
            currentBoxId: "",
            currentSeatId: "",
            currentSeatLabel: "",
            updatedAt: Date.now()
          },
          { merge: true }
        ),
        clearUserSeatNotification(user.uid)
      ]);
    } catch (err) {
      console.error("forceSelfCheckedOut cleanup:", err);
      restoreAttendanceSnapshot(tournamentId, user.uid, prevSnap);
    }
  })();
}
