import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import {
  removeUserFromAllSeatsGlobal,
  clearUserFromGlobalSeats,
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

async function runCheckedOutCleanup(target, { clearGlobalSeats = false } = {}) {
  const tournamentId = getTournamentId();
  if (!target?.uid || !tournamentId) return;

  await Promise.all([
    // 통합배치도 좌석 비우기 — global_seats 쓰기는 관리자만 가능해서 관리자 퇴근 처리에서만.
    clearGlobalSeats ? clearUserFromGlobalSeats(tournamentId, target.uid) : Promise.resolve(0),
    // 아래 두 쓰기(개별 배치도·알림 문서 type 변경)는 관리자만 가능 — 근무자 본인 퇴근에선
    // 항상 거부되니 시도하지 않는다. 좌석 자체는 관리자가 비울 때 함께 정리된다.
    clearGlobalSeats ? removeUserFromAllSeatsGlobal({ uid: target.uid }) : Promise.resolve(0),
    removeFromSharedWaitingOnCheckOut(
      {
        uid: target.uid,
        email: target.email || "",
        displayName: target.nickname || target.name || "",
        nickname: target.nickname || target.name || "",
        name: target.nickname || target.name || ""
      },
      { selfOnly: !clearGlobalSeats }
    ),
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
    clearGlobalSeats ? clearUserSeatNotification(target.uid) : Promise.resolve()
  ]);
}

export async function forceAdminCheckedOut(target) {
  if (!target?.uid) return false;

  const tournamentId = getTournamentId();

  const saved = await updateAdminAttendanceStatus(target.uid, "checked_out", { optimistic: true });
  if (!saved) return false;
  applyCheckedOutSeatClear(tournamentId, target.uid);

  try {
    await runCheckedOutCleanup(target, { clearGlobalSeats: true });
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
