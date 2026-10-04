import { auth, db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import {
  ensureTournamentContextOrAlert,
  chunkArray,
  commitBatchWithRetry
} from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getLayoutEventDocByEventAndBox } from "./layout-events.js";
import { globalWaitingCollectionRef } from "../shared/tournament-waiting-queue.js";

export async function removeUsersFromSharedWaitingByUids(targetUids = [], tournamentId = "") {
  const uidSet = new Set(
    (Array.isArray(targetUids) ? targetUids : [])
      .map((uid) => String(uid || "").trim())
      .filter(Boolean)
  );
  const tid = String(tournamentId || "").trim();

  if (!uidSet.size || !tid) return;

  const collRef = globalWaitingCollectionRef(db, tid);
  const uidChunks = chunkArray([...uidSet], 30);

  const refsToDelete = new Map();
  for (const chunk of uidChunks) {
    const snap = await getDocs(query(collRef, where("uid", "in", chunk)));
    snap.docs.forEach((d) => refsToDelete.set(d.ref.path, d.ref));
  }

  if (!refsToDelete.size) return;

  for (const refsChunk of chunkArray([...refsToDelete.values()], 400)) {
    const batch = writeBatch(db);
    refsChunk.forEach((ref) => batch.delete(ref));
    await commitBatchWithRetry(batch, { maxRetries: 1, retryDelayMs: 250 });
  }
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
  if (!canUseTournamentOps(auth.currentUser?.email, IX.currentUserProfile, tournamentId)) {
    return { affectedUsers: [] };
  }

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

    await removeUsersFromSharedWaitingByUids(affectedUsers.map((u) => u.uid), tournamentId);
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

function refMatchesEvent(docSnap, eid) {
  const d = docSnap.data() || {};
  if (String(docSnap.id || "").startsWith(`${eid}__`)) return true;
  return (
    String(d.eventId || "").trim() === eid ||
    String(d.currentEventId || "").trim() === eid ||
    String(d.mappedEventId || "").trim() === eid
  );
}

async function deleteRefsInBatches(refs = []) {
  for (const refsChunk of chunkArray(refs, 400)) {
    const batch = writeBatch(db);
    refsChunk.forEach((ref) => batch.delete(ref));
    await commitBatchWithRetry(batch, { maxRetries: 1, retryDelayMs: 250 });
  }
}

/**
 * 이벤트 카드 삭제 시 그 이벤트 ID에 묶인 데이터를 전부 지운다.
 * 같은 ID로 카드를 다시 만들었을 때 예전 좌석·배치 이력·배치도가 되살아나지 않게 한다.
 * - tournaments/{tid}/global_seats : 해당 이벤트 좌석 문서
 * - tournaments/{tid}/global_seats_archive : 해당 이벤트 좌석 배치 이력 보관본
 * - layout_events : 해당 이벤트 배치도 문서
 * 출퇴근 로그(dealer_attendance_logs)는 근무 요약·인건비 근거라 남긴다.
 */
export async function purgeDeletedEventData({ eventId = "" } = {}) {
  const tournamentId = ensureTournamentContextOrAlert();
  const eid = String(eventId || "").trim();
  if (!tournamentId || !eid) return { deleted: 0 };
  if (!canUseTournamentOps(auth.currentUser?.email, IX.currentUserProfile, tournamentId)) {
    return { deleted: 0 };
  }

  const [seatsSnap, archiveSnap, layoutSnap] = await Promise.all([
    getDocs(collection(db, "tournaments", tournamentId, "global_seats")),
    getDocs(collection(db, "tournaments", tournamentId, "global_seats_archive")),
    getDocs(collection(db, "layout_events"))
  ]);

  const refs = [
    ...seatsSnap.docs.filter((d) => refMatchesEvent(d, eid)),
    ...archiveSnap.docs.filter((d) => refMatchesEvent(d, eid)),
    ...layoutSnap.docs.filter((d) => {
      if (!refMatchesEvent(d, eid)) return false;
      const t = String(d.data()?.tournamentId || "").trim();
      return !t || t === tournamentId;
    })
  ].map((d) => d.ref);

  await deleteRefsInBatches(refs);
  return { deleted: refs.length };
}
