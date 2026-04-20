import { setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import {
  removeUserFromAllSeatsGlobal,
  removeFromSharedWaitingOnCheckOut,
  clearUserSeatNotification
} from "./dealer-attendance-waiting.js";
import {
  updateMyAttendanceStatus,
  updateAdminAttendanceStatus
} from "./dealer-attendance-status-updates.js";

export async function forceAdminCheckedOut(target) {
  if (!target?.uid) return;

  await removeUserFromAllSeatsGlobal({ uid: target.uid });
  await removeFromSharedWaitingOnCheckOut({
    uid: target.uid,
    email: target.email || "",
    displayName: target.nickname || "",
    nickname: target.nickname || ""
  });
  await updateAdminAttendanceStatus(target.uid, "checked_out");
  await setDoc(
    getAttendanceRef(getTournamentId(), target.uid),
    {
      currentEventId: "",
      currentBoxId: "",
      currentSeatId: "",
      currentSeatLabel: "",
      updatedAt: Date.now()
    },
    { merge: true }
  );
  await clearUserSeatNotification(target.uid);
}

export async function forceSelfCheckedOut(user) {
  if (!user?.uid) return;

  const targetProfile = IX.currentUserProfile || {};

  await removeUserFromAllSeatsGlobal({ uid: user.uid });
  await removeFromSharedWaitingOnCheckOut({
    uid: user.uid,
    email: String(targetProfile.email || user.email || "").trim(),
    displayName: String(targetProfile.nickname || user.displayName || "").trim(),
    nickname: String(targetProfile.nickname || user.displayName || "").trim()
  });

  await updateMyAttendanceStatus("checked_out");

  await setDoc(
    getAttendanceRef(getTournamentId(), user.uid),
    {
      currentEventId: "",
      currentBoxId: "",
      currentSeatId: "",
      currentSeatLabel: "",
      updatedAt: Date.now()
    },
    { merge: true }
  );

  await clearUserSeatNotification(user.uid);
}
