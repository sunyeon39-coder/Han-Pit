import { auth, db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
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

function mergeAffectedUser(map, user) {
  const uid = String(user?.uid || "").trim();
  if (!uid) return;
  const prev = map.get(uid);
  if (!prev) {
    map.set(uid, {...user, uid});
    return;
  }
  map.set(uid, {
    ...prev,
    nickname: String(prev.nickname || user.nickname || "").trim(),
    email: String(prev.email || user.email || "").trim(),
    seatId: String(prev.seatId || user.seatId || "").trim(),
    seatLabel: String(prev.seatLabel || user.seatLabel || "").trim()
  });
}

/**
 * 이벤트 카드 삭제 시 layout_events 좌석 + tournaments/.../global_seats 잔여 배치를 비우고
 * 해당 딜러는 즉시 checked_out 로 맞춘다 (merge 잔상 출근 시각 제거).
 */
export async function forceCheckOutUsersForDeletedEvent({ eventId = "", boxId = "" }) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return { affectedUsers: [] };
  if (!getIsAdmin(auth.currentUser, IX.currentUserProfile)) return { affectedUsers: [] };

  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!eid) return { affectedUsers: [] };

  const affectedByUid = new Map();
  const globalSeatRefsToClear = [];

  const layoutDoc = await getLayoutEventDocByEventAndBox(eid, bid);
  let layoutData = {};
  let seats = [];

  if (layoutDoc) {
    layoutData = layoutDoc.data || {};
    seats = Array.isArray(layoutData.seats) ? layoutData.seats : [];
    seats
      .filter((seat) => seat && typeof seat === "object")
      .map((seat) => ({
        uid: String(seat.personUid || "").trim(),
        nickname: String(seat.person || "").trim(),
        email: String(seat.personEmail || "").trim(),
        seatId: String(seat.id || "").trim(),
        seatLabel: String(seat.label ?? seat.no ?? "").trim()
      }))
      .filter((user) => user.uid)
      .forEach((u) => mergeAffectedUser(affectedByUid, u));
  }

  const gsSnap = await getDocs(collection(db, "tournaments", tournamentId, "global_seats"));
  gsSnap.forEach((docSnap) => {
    const d = docSnap.data() || {};
    const ev = String(d.currentEventId || d.mappedEventId || "").trim();
    if (ev !== eid) return;
    if (bid && String(d.boxId || "").trim() !== bid) return;
    const uid = String(d.personUid || "").trim();
    const person = String(d.person || "").trim();
    if (!uid || !person || person === "비어있음") return;
    mergeAffectedUser(affectedByUid, {
      uid,
      nickname: person,
      email: String(d.personEmail || "").trim(),
      seatId: String(d.seatId || "").trim(),
      seatLabel: String(d.label ?? d.no ?? "").trim()
    });
    globalSeatRefsToClear.push(docSnap.ref);
  });

  const affectedUsers = [...affectedByUid.values()];

  if (!affectedUsers.length && !layoutDoc && !globalSeatRefsToClear.length) {
    return { affectedUsers: [] };
  }

  const now = Date.now();

  if (affectedUsers.length) {
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
            checkedInAt: null,
            checkedOutAt: now,
            breakStartedAt: null,
            totalBreakMs: 0,
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
          eventId: eid,
          boxId: bid,
          seatId: user.seatId,
          seatLabel: user.seatLabel
        })
      )
    );

    await removeUsersFromSharedWaitingByUids(affectedUsers.map((u) => u.uid));
  }

  if (layoutDoc) {
    await setDoc(
      layoutDoc.ref,
      {
        ...layoutData,
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
  }

  for (const refsChunk of chunkArray(globalSeatRefsToClear, 400)) {
    const batch = writeBatch(db);
    refsChunk.forEach((ref) => {
      batch.set(
        ref,
        {
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null,
          status: "empty",
          updatedAt: now
        },
        { merge: true }
      );
    });
    await commitBatchWithRetry(batch, { maxRetries: 1, retryDelayMs: 250 });
  }

  return { affectedUsers };
}
