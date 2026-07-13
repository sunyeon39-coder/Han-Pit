import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

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
import { applyOptimisticAttendanceEntry } from "./dealer-attendance-optimistic.js";

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

async function runCheckedOutCleanup(target) {
  const tournamentId = getTournamentId();
  if (!target?.uid || !tournamentId) return;

  await Promise.all([
    removeUserFromAllSeatsGlobal({ uid: target.uid }),
    removeFromSharedWaitingOnCheckOut({
      uid: target.uid,
      email: target.email || "",
      displayName: target.nickname || target.name || "",
      nickname: target.nickname || target.name || "",
      name: target.nickname || target.name || ""
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
}

export async function forceAdminCheckedOut(target) {
  if (!target?.uid) return false;

  const tournamentId = getTournamentId();

  const saved = await updateAdminAttendanceStatus(target.uid, "checked_out", { optimistic: true });
  if (!saved) return false;
  applyCheckedOutSeatClear(tournamentId, target.uid);

  try {
    await runCheckedOutCleanup(target);
  } catch (err) {
    console.error("forceAdminCheckedOut cleanup:", err);
  }
  return true;
}

export async function forceSelfCheckedOut(user) {
  if (!user?.uid) return;

  const tournamentId = getTournamentId();
  const targetProfile = IX.currentUserProfile || {};

  await updateMyAttendanceStatus("checked_out", { optimistic: true });
  applyCheckedOutSeatClear(tournamentId, user.uid);

  try {
    await runCheckedOutCleanup({
      uid: user.uid,
      email: String(targetProfile.email || user.email || "").trim(),
      nickname: String(targetProfile.nickname || user.displayName || "").trim(),
      name: String(targetProfile.nickname || user.displayName || "").trim()
    });
  } catch (err) {
    console.error("forceSelfCheckedOut cleanup:", err);
  }
}
