import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import {
  applyOperationalDayToAttendance,
  isStaleOperationalDayAttendance
} from "../shared/attendance-operational-day.js";
import { removeFromSharedWaitingOnCheckOut } from "./dealer-attendance-waiting.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getNowMs } from "./dealer-attendance-format.js";

const resetInflight = new Set();

function buildOperationalDayResetPayload(row = {}) {
  const now = getNowMs();
  return {
    uid: String(row.uid || "").trim(),
    nickname: String(row.nickname || "").trim(),
    email: String(row.email || "").trim(),
    tournamentId: String(row.tournamentId || getTournamentId() || "").trim(),
    status: "off",
    checkedInAt: null,
    checkedOutAt: null,
    breakStartedAt: null,
    totalBreakMs: 0,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: "",
    updatedAt: now
  };
}

export function normalizeAttendanceForOperationalDay(data = {}) {
  const row = normalizeAttendanceDoc(data);
  return applyOperationalDayToAttendance(row);
}

export async function persistOperationalDayResetForUid(uid = "", prevRow = null) {
  const safeUid = String(uid || "").trim();
  const tournamentId = getTournamentId();
  if (!safeUid || !tournamentId) return false;
  if (resetInflight.has(safeUid)) return false;

  const docId = getAttendanceDocId(tournamentId, safeUid);
  const current = prevRow || IX.dealerAttendanceMap.get(docId);
  if (!isStaleOperationalDayAttendance(current)) return false;

  resetInflight.add(safeUid);
  try {
    const payload = buildOperationalDayResetPayload(current);
    await setDoc(getAttendanceRef(tournamentId, safeUid), payload, { merge: true });
    IX.dealerAttendanceMap.set(docId, payload);
    await removeFromSharedWaitingOnCheckOut({ uid: safeUid });
    void writeAttendanceLog({
      uid: safeUid,
      nickname: payload.nickname,
      action: "operational_day_reset",
      tournamentId,
      eventId: "",
      boxId: "",
      seatId: "",
      seatLabel: ""
    }).catch((err) => console.warn("operational_day_reset log:", err));
    return true;
  } catch (err) {
    console.warn("persistOperationalDayResetForUid:", err?.code || err);
    return false;
  } finally {
    resetInflight.delete(safeUid);
  }
}

export async function maybeResetMyStaleOperationalDayAttendance(user) {
  if (!user?.uid) return false;
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;
  const docId = getAttendanceDocId(tournamentId, user.uid);
  const current = IX.dealerAttendanceMap.get(docId);
  if (!isStaleOperationalDayAttendance(current)) return false;
  return persistOperationalDayResetForUid(user.uid, current);
}
