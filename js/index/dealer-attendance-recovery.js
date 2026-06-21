import { db } from "../firebase.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getLayoutEventDocByEventAndBox } from "./layout-events.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { joinSharedWaitingOnCheckIn } from "./dealer-attendance-waiting.js";
import { getBaseAttendance, getDerivedAttendance } from "./dealer-attendance-derived.js";
import { isStaleOperationalDayAttendance } from "../shared/attendance-operational-day.js";
import { renderDealerOps } from "./dealer-attendance-render.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";

const ASSIGNED_RECOVERY_GRACE_MS = 15000;

export function getMySeatInfo(uid) {
  return IX.dealerSeatMap.get(uid) || null;
}

export async function getSharedWaitingState() {
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  if (!snap.exists()) {
    return {
      ref: waitingRef,
      state: { version: 2, waiting: [], updatedAt: Date.now() }
    };
  }

  const data = snap.data() || {};
  return {
    ref: waitingRef,
    state: {
      ...data,
      version: 2,
      waiting: Array.isArray(data.waiting) ? data.waiting : [],
      updatedAt: Number(data.updatedAt || Date.now())
    }
  };
}

export async function hasRemoteAssignedSeatForUser(attendance = {}, uid = "") {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return false;

  const eventId = String(attendance.currentEventId || "").trim();
  const boxId = String(attendance.currentBoxId || "").trim();
  const seatId = String(attendance.currentSeatId || "").trim();

  if (!eventId || !boxId) return false;

  try {
    const layoutDoc = await getLayoutEventDocByEventAndBox(eventId, boxId);
    if (!layoutDoc) return false;

    const data = layoutDoc.data || {};
    const seats = Array.isArray(data.seats) ? data.seats : [];

    const foundSeat = seats.find((seat) => {
      const seatUid = String(seat?.personUid || "").trim();
      if (!seatUid || seatUid !== safeUid) return false;
      if (!seatId) return true;
      return String(seat?.id || "").trim() === seatId;
    });

    if (!foundSeat) return false;

    IX.dealerSeatMap.set(safeUid, {
      eventId,
      boxId,
      seatId: String(foundSeat?.id || "").trim(),
      seatLabel: String(foundSeat?.label ?? foundSeat?.no ?? "")
    });
    return true;
  } catch (err) {
    console.error("hasRemoteAssignedSeatForUser error:", err);
    return false;
  }
}

export async function ensureMeRecovered(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return;

  const raw = getBaseAttendance(user);
  if (isStaleOperationalDayAttendance(raw)) return;

  const me = getDerivedAttendance(user);
  const seatInfo = getMySeatInfo(user.uid);

  const { ref: waitingRef, state: waitingStateDoc } = await getSharedWaitingState();
  const waitingList = Array.isArray(waitingStateDoc.waiting) ? waitingStateDoc.waiting : [];

  const inWaiting = waitingList.some((item) => {
    if (!item || typeof item !== "object") return false;
    return String(item.uid || "").trim() === String(user.uid).trim();
  });

  if (me?.status === "assigned" && !seatInfo) {
    const remoteAssigned = await hasRemoteAssignedSeatForUser(me, user.uid);
    if (remoteAssigned) {
      renderDealerOps();
      return;
    }

    const updatedAt = Number(me?.updatedAt || 0);
    if (updatedAt && Date.now() - updatedAt < ASSIGNED_RECOVERY_GRACE_MS) {
      return;
    }

    const nickname =
      String(IX.currentUserProfile?.nickname || user.displayName || "").trim() ||
      String(user.email || "").trim();

    await setDoc(
      getAttendanceRef(tournamentId, user.uid),
      {
        uid: user.uid,
        tournamentId,
        email: String(IX.currentUserProfile?.email || user.email || "").trim(),
        nickname,
        status: "waiting",
        currentEventId: "",
        currentBoxId: "",
        currentSeatId: "",
        currentSeatLabel: "",
        updatedAt: Date.now()
      },
      { merge: true }
    );

    if (!inWaiting) {
      waitingList.push({
        id: `w_${user.uid}`,
        uid: user.uid,
        email: String(IX.currentUserProfile?.email || user.email || "").trim(),
        name: nickname,
        addedAt: Date.now(),
        source: "auto_recover_assigned",
        tournamentId
      });

      await setDoc(
        waitingRef,
        {
          ...waitingStateDoc,
          version: 2,
          waiting: waitingList,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    }

    await loadDealerAttendanceOnce();
    renderDealerOps();
    return;
  }

  if ((me?.status === "waiting" || me?.status === "checked_in") && !inWaiting && !seatInfo) {
    if (
      !canUseTournamentOps(user?.email, IX.currentUserProfile, tournamentId)
    ) {
      await joinSharedWaitingOnCheckIn(user);
    }
    await loadDealerAttendanceOnce();
    renderDealerOps();
  }
}
