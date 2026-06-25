import { auth } from "../firebase.js";
import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId, ensureTournamentContextOrAlert } from "./core-utils.js";
import { buildOptimisticProfileFromAuthUser } from "../shared/login-profile-cache.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { getNowMs } from "./dealer-attendance-format.js";
import {
  applyOptimisticAttendanceEntry,
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";
import {
  isActiveAttendanceStatus,
  resolveCheckedInAtForActiveStatus
} from "../shared/attendance-operational-day.js";

function buildMyAttendancePayload(user, nextStatus) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return null;

  if (!IX.currentUserProfile) {
    IX.currentUserProfile = buildOptimisticProfileFromAuthUser(user, {});
  }

  const current = getDerivedAttendance(user);
  const now = getNowMs();
  // 출근하기(off/checked_out → waiting): 이전 이력을 이어받지 않고 완전히 새로 시작한다.
  const freshCheckIn = nextStatus === "waiting" && !isActiveAttendanceStatus(current?.status);
  const enteringWaiting = nextStatus === "waiting" && String(current?.status || "").trim() !== "waiting";

  return {
    uid: user.uid,
    nickname: String(IX.currentUserProfile.nickname || user.displayName || "").trim(),
    email: String(IX.currentUserProfile.email || user.email || "").trim(),
    tournamentId,
    status: nextStatus,
    checkedInAt: resolveCheckedInAtForActiveStatus(current, nextStatus, now),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt: nextStatus === "break" ? now : null,
    statusChangedAt:
      freshCheckIn || enteringWaiting ? now : Number(current?.statusChangedAt || 0) || null,
    totalBreakMs: freshCheckIn
      ? 0
      : nextStatus === "waiting" && current?.status === "break" && current?.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current.totalBreakMs || 0),
    currentEventId: freshCheckIn ? "" : current?.currentEventId || "",
    currentBoxId: freshCheckIn ? "" : current?.currentBoxId || "",
    currentSeatId: freshCheckIn ? "" : current?.currentSeatId || "",
    currentSeatLabel: freshCheckIn ? "" : current?.currentSeatLabel || "",
    updatedAt: now
  };
}

function buildAdminAttendancePayload(uid, nextStatus) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!uid || !tournamentId) return null;

  const current = IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, uid));
  if (!current) return null;

  const now = getNowMs();
  const freshCheckIn = nextStatus === "waiting" && !isActiveAttendanceStatus(current?.status);
  const enteringWaiting = nextStatus === "waiting" && String(current?.status || "").trim() !== "waiting";

  return {
    ...current,
    status: nextStatus,
    checkedInAt: resolveCheckedInAtForActiveStatus(current, nextStatus, now),
    checkedOutAt: nextStatus === "checked_out" ? now : null,
    breakStartedAt: nextStatus === "break" ? now : null,
    statusChangedAt:
      freshCheckIn || enteringWaiting ? now : Number(current?.statusChangedAt || 0) || null,
    totalBreakMs: freshCheckIn
      ? 0
      : nextStatus === "waiting" && current.status === "break" && current.breakStartedAt
        ? Number(current.totalBreakMs || 0) + Math.max(0, now - Number(current.breakStartedAt || 0))
        : Number(current.totalBreakMs || 0),
    ...(freshCheckIn
      ? { currentEventId: "", currentBoxId: "", currentSeatId: "", currentSeatLabel: "" }
      : {}),
    updatedAt: now
  };
}

export async function updateMyAttendanceStatus(nextStatus, options = {}) {
  const user = auth.currentUser;
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return;

  const payload = buildMyAttendancePayload(user, nextStatus);
  if (!payload) return;

  const optimistic = options.optimistic !== false;
  const prevSnap = optimistic ? snapshotAttendanceEntry(tournamentId, user.uid) : null;

  if (optimistic) {
    applyOptimisticAttendanceEntry(tournamentId, user.uid, payload);
  }

  try {
    await setDoc(getAttendanceRef(tournamentId, user.uid), payload, { merge: true });
    void writeAttendanceLog({
      uid: user.uid,
      nickname: payload.nickname,
      action: nextStatus,
      tournamentId,
      eventId: payload.currentEventId || "",
      boxId: payload.currentBoxId || "",
      seatId: payload.currentSeatId || "",
      seatLabel: payload.currentSeatLabel || ""
    }).catch((err) => console.warn("writeAttendanceLog:", err));
  } catch (err) {
    if (optimistic) restoreAttendanceSnapshot(tournamentId, user.uid, prevSnap);
    throw err;
  }
}

export async function updateAdminAttendanceStatus(uid, nextStatus, options = {}) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!uid || !tournamentId) return;

  const payload = buildAdminAttendancePayload(uid, nextStatus);
  if (!payload) return;

  const optimistic = options.optimistic !== false;
  const prevSnap = optimistic ? snapshotAttendanceEntry(tournamentId, uid) : null;

  if (optimistic) {
    applyOptimisticAttendanceEntry(tournamentId, uid, payload);
  }

  try {
    await setDoc(getAttendanceRef(tournamentId, uid), payload, { merge: true });
    void writeAttendanceLog({
      uid,
      nickname: String(payload.nickname || "").trim(),
      action: nextStatus,
      tournamentId,
      eventId: payload.currentEventId || "",
      boxId: payload.currentBoxId || "",
      seatId: payload.currentSeatId || "",
      seatLabel: payload.currentSeatLabel || ""
    }).catch((err) => console.warn("writeAttendanceLog:", err));
  } catch (err) {
    if (optimistic) restoreAttendanceSnapshot(tournamentId, uid, prevSnap);
    throw err;
  }
}
