import { auth } from "../firebase.js";
import { setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getTournamentId, ensureTournamentContextOrAlert } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { getNowMs } from "./dealer-attendance-format.js";

export async function updateMyAttendanceStatus(nextStatus) {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !IX.currentUserProfile) return;

  const current = getDerivedAttendance(user);
  const now = getNowMs();

  const payload = {
    uid: user.uid,
    nickname: String(IX.currentUserProfile.nickname || user.displayName || "").trim(),
    email: String(IX.currentUserProfile.email || user.email || "").trim(),
    tournamentId,
    status: nextStatus,
    checkedInAt:
      nextStatus === "checked_in" || nextStatus === "waiting" || nextStatus === "break"
        ? (current?.checkedInAt || now)
        : (current?.checkedInAt || null),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt: nextStatus === "break" ? now : null,
    totalBreakMs:
      nextStatus === "waiting" && current?.status === "break" && current?.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current?.totalBreakMs || 0),
    currentEventId: current?.currentEventId || "",
    currentBoxId: current?.currentBoxId || "",
    currentSeatId: current?.currentSeatId || "",
    currentSeatLabel: current?.currentSeatLabel || "",
    updatedAt: now
  };

  await setDoc(getAttendanceRef(tournamentId, user.uid), payload, { merge: true });

  await writeAttendanceLog({
    uid: user.uid,
    nickname: String(IX.currentUserProfile.nickname || user.displayName || "").trim(),
    action: nextStatus,
    tournamentId,
    eventId: current?.currentEventId || "",
    boxId: current?.currentBoxId || "",
    seatId: current?.currentSeatId || "",
    seatLabel: current?.currentSeatLabel || ""
  });
}

export async function updateAdminAttendanceStatus(uid, nextStatus) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!uid || !tournamentId) return;

  const current = IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, uid));
  if (!current) return;

  const now = getNowMs();

  const payload = {
    ...current,
    status: nextStatus,
    checkedInAt:
      nextStatus === "checked_in" || nextStatus === "waiting" || nextStatus === "break"
        ? (current.checkedInAt || now)
        : (current.checkedInAt || null),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt: nextStatus === "break" ? now : null,
    totalBreakMs:
      nextStatus === "waiting" && current.status === "break" && current.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current.totalBreakMs || 0),
    updatedAt: now
  };

  await setDoc(getAttendanceRef(tournamentId, uid), payload, { merge: true });

  await writeAttendanceLog({
    uid,
    nickname: String(current.nickname || "").trim(),
    action: nextStatus,
    tournamentId,
    eventId: current?.currentEventId || "",
    boxId: current?.currentBoxId || "",
    seatId: current?.currentSeatId || "",
    seatLabel: current?.currentSeatLabel || ""
  });
}
