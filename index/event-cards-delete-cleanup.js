import { auth, db } from "../firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import {
  ensureTournamentContextOrAlert,
  chunkArray,
  commitBatchWithRetry
} from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getLayoutEventDocByEventAndBox } from "./layout-events.js";

export async function removeUsersFromSharedWaitingByUids(targetUids = []) {
  const uidSet = new Set(
    (Array.isArray(targetUids) ? targetUids : [])
      .map((uid) => String(uid || "").trim())
      .filter(Boolean)
  );

  if (!uidSet.size) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  if (!snap.exists()) return;

  const data = snap.data() || {};
  const waiting = Array.isArray(data.waiting) ? data.waiting : [];

  const nextWaiting = waiting.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const uid = String(item.uid || "").trim();
    return !uidSet.has(uid);
  });

  if (nextWaiting.length === waiting.length) return;

  await setDoc(
    waitingRef,
    {
      ...data,
      version: 2,
      waiting: nextWaiting,
      updatedAt: Date.now()
    },
    { merge: true }
  );
}

export async function forceCheckOutUsersForDeletedEvent({ eventId = "", boxId = "" }) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return { affectedUsers: [] };
  if (!getIsAdmin(auth.currentUser, IX.currentUserProfile)) return { affectedUsers: [] };

  const layoutDoc = await getLayoutEventDocByEventAndBox(eventId, boxId);
  if (!layoutDoc) return { affectedUsers: [] };

  const data = layoutDoc.data || {};
  const seats = Array.isArray(data.seats) ? data.seats : [];

  const affectedUsers = seats
    .filter((seat) => seat && typeof seat === "object")
    .map((seat) => ({
      uid: String(seat.personUid || "").trim(),
      nickname: String(seat.person || "").trim(),
      email: String(seat.personEmail || "").trim(),
      seatId: String(seat.id || "").trim(),
      seatLabel: String(seat.label ?? seat.no ?? "").trim()
    }))
    .filter((user) => user.uid);

  const now = Date.now();

  for (const usersChunk of chunkArray(affectedUsers, 200)) {
    const batch = writeBatch(db);

    usersChunk.forEach((user) => {
      batch.set(
        getAttendanceRef(tournamentId, user.uid),
        {
          uid: user.uid,
          tournamentId,
          nickname: user.nickname,
          email: user.email,
          status: "checked_out",
          checkedOutAt: now,
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: "",
          updatedAt: now
        },
        { merge: true }
      );

      batch.set(
        doc(db, "layout_notifications", user.uid),
        {
          type: "event_deleted",
          acknowledged: true,
          seatId: "",
          seatLabel: "",
          eventId: "",
          eventTitle: "",
          boxId: "",
          targetUrl: "",
          message: "",
          updatedAt: now
        },
        { merge: true }
      );
    });

    await commitBatchWithRetry(batch, { maxRetries: 1, retryDelayMs: 250 });
  }

  await Promise.allSettled(
    affectedUsers.map((user) =>
      writeAttendanceLog({
        uid: user.uid,
        nickname: user.nickname,
        action: "checked_out",
        tournamentId,
        eventId,
        boxId,
        seatId: user.seatId,
        seatLabel: user.seatLabel
      })
    )
  );

  await removeUsersFromSharedWaitingByUids(affectedUsers.map((u) => u.uid));

  await setDoc(
    layoutDoc.ref,
    {
      ...data,
      seats: seats.map((seat) => ({
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      })),
      updatedAt: now
    },
    { merge: true }
  );

  return { affectedUsers };
}
