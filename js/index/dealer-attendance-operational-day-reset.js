import { setDoc, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { db } from "../firebase.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId, getAttendanceRef } from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import {
  applyOperationalDayToAttendance,
  isStaleOperationalDayAttendance
} from "../shared/attendance-operational-day.js";
import {
  findGlobalWaitingRowForUid,
  getWaitingRowJoinMs,
  hasFreshGlobalWaitingForUid
} from "../shared/tournament-waiting-queue.js";
import { removeFromSharedWaitingOnCheckOut } from "./dealer-attendance-waiting.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getNowMs } from "./dealer-attendance-format.js";

const resetInflight = new Set();

async function loadGlobalWaitingRows() {
  try {
    const snap = await getDoc(doc(db, "layout_shared", "global_waiting"));
    if (!snap.exists()) return [];
    const data = snap.data() || {};
    return Array.isArray(data.waiting) ? data.waiting : [];
  } catch (err) {
    console.warn("loadGlobalWaitingRows:", err?.code || err);
    return IX.globalWaiting || [];
  }
}

function buildWaitingHealPayload(current = {}, waitRow = {}, tournamentId = "") {
  const now = getNowMs();
  const joinMs = getWaitingRowJoinMs(waitRow) || now;
  return {
    uid: String(current.uid || waitRow.uid || "").trim(),
    nickname: String(current.nickname || waitRow.name || "").trim(),
    email: String(current.email || waitRow.email || "").trim(),
    tournamentId: String(tournamentId || "").trim(),
    status: "waiting",
    checkedInAt: joinMs,
    checkedOutAt: null,
    breakStartedAt: null,
    totalBreakMs: 0,
    statusChangedAt: joinMs,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: "",
    updatedAt: now
  };
}

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

  const globalWaiting = await loadGlobalWaitingRows();
  if (hasFreshGlobalWaitingForUid(globalWaiting, tournamentId, safeUid)) {
    const waitRow = findGlobalWaitingRowForUid(globalWaiting, tournamentId, safeUid);
    resetInflight.add(safeUid);
    try {
      const payload = buildWaitingHealPayload(current, waitRow || {}, tournamentId);
      await setDoc(getAttendanceRef(tournamentId, safeUid), payload, { merge: true });
      IX.dealerAttendanceMap.set(docId, payload);
      return true;
    } catch (err) {
      console.warn("persistOperationalDayResetForUid heal:", err?.code || err);
      return false;
    } finally {
      resetInflight.delete(safeUid);
    }
  }

  resetInflight.add(safeUid);
  try {
    const stillQueued = findGlobalWaitingRowForUid(globalWaiting, tournamentId, safeUid);
    if (stillQueued) {
      const payload = buildWaitingHealPayload(current, stillQueued, tournamentId);
      await setDoc(getAttendanceRef(tournamentId, safeUid), payload, { merge: true });
      IX.dealerAttendanceMap.set(docId, payload);
      return true;
    }

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
