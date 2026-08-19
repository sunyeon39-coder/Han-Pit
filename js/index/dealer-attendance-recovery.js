import { db } from "../firebase.js";
import { doc, getDoc, getDocs, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import { runSerializedGlobalWaitingWrite } from "../global-layout/global-waiting-write-lock.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getLayoutEventDocByEventAndBox } from "./layout-events.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { joinSharedWaitingOnCheckIn } from "./dealer-attendance-waiting.js";
import { getBaseAttendance, getDerivedAttendance } from "./dealer-attendance-derived.js";
import { isStaleOperationalDayAttendance } from "../shared/attendance-operational-day.js";
import {
  getWaitingRowJoinMs,
  globalWaitingCollectionRef,
  globalWaitingDocRef
} from "../shared/tournament-waiting-queue.js";
import { findGlobalWaitingEntryRefs, diffGlobalWaitingRows } from "../global-layout/waiting-entry-refs.js";
import { renderDealerOps } from "./dealer-attendance-render.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";

const ASSIGNED_RECOVERY_GRACE_MS = 15000;

export function getMySeatInfo(uid) {
  return IX.dealerSeatMap.get(uid) || null;
}

export async function getSharedWaitingState(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) {
    return { collRef: null, state: { version: 2, waiting: [], updatedAt: Date.now() } };
  }

  const collRef = globalWaitingCollectionRef(db, tid);
  const snap = await getDocs(collRef);

  return {
    collRef,
    state: {
      version: 2,
      waiting: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      updatedAt: Date.now()
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
  const seatInfo = getMySeatInfo(user.uid);

  const { state: waitingStateDoc } = await getSharedWaitingState(tournamentId);
  const waitingList = Array.isArray(waitingStateDoc.waiting) ? waitingStateDoc.waiting : [];

  const nickname =
    String(IX.currentUserProfile?.nickname || user.displayName || "").trim() ||
    String(user.email || "").trim();

  const inWaiting = waitingList.some((item) => {
    if (!item || typeof item !== "object") return false;
    const itemUid = String(item.uid || "").trim();
    const itemTournamentId = String(item.tournamentId || "").trim();
    const itemName = String(item.name || "").trim();
    if (itemTournamentId && itemTournamentId !== tournamentId) return false;
    if (itemUid && itemUid === String(user.uid).trim()) return true;
    if (nickname && itemName && itemName === nickname) return true;
    return false;
  });

  if (isStaleOperationalDayAttendance(raw) && inWaiting) {
    const waitRow =
      waitingList.find((item) => String(item?.uid || "").trim() === String(user.uid).trim()) || {};
    const joinMs = getWaitingRowJoinMs(waitRow) || Date.now();
    const nickname =
      String(IX.currentUserProfile?.nickname || raw?.nickname || user.displayName || "").trim() ||
      String(user.email || "").trim();

    await setDoc(
      getAttendanceRef(tournamentId, user.uid),
      {
        uid: user.uid,
        tournamentId,
        email: String(IX.currentUserProfile?.email || raw?.email || user.email || "").trim(),
        nickname,
        status: "waiting",
        checkedInAt: joinMs,
        checkedOutAt: null,
        statusChangedAt: joinMs,
        currentEventId: "",
        currentBoxId: "",
        currentSeatId: "",
        currentSeatLabel: "",
        updatedAt: Date.now()
      },
      { merge: true }
    );
    await loadDealerAttendanceOnce();
    renderDealerOps();
    return;
  }

  if (isStaleOperationalDayAttendance(raw)) return;

  const me = getDerivedAttendance(user);

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
      // 후보 문서를 미리 추려두고, 실제 쓰기 직전에 트랜잭션으로 다시 읽어 반영한다
      // (그 사이 다른 클라이언트가 반영한 변경을 덮어쓰는 lost update 방지).
      const person = {
        uid: user.uid,
        email: String(IX.currentUserProfile?.email || user.email || "").trim(),
        name: nickname
      };
      const canonicalRef = globalWaitingDocRef(db, tournamentId, `w_${user.uid}`);
      const matchRefs = findGlobalWaitingEntryRefs(db, tournamentId, waitingList, person);
      const refs = matchRefs.some((r) => r.path === canonicalRef.path)
        ? matchRefs
        : [canonicalRef, ...matchRefs];

      await runSerializedGlobalWaitingWrite(() =>
        runFirestoreTransactionWithRetry(db, async (tx) => {
          const snaps = await Promise.all(refs.map((r) => tx.get(r)));
          const prevRows = snaps
            .map((s, i) => (s.exists() ? { id: refs[i].id, ...s.data() } : null))
            .filter(Boolean);
          const existingByPerson = prevRows[0] || null;

          const recoverNow = Date.now();
          const recoverRow = {
            id: String(existingByPerson?.id || `w_${user.uid}`).trim(),
            uid: user.uid,
            email: person.email,
            name: nickname,
            addedAt: Number(existingByPerson?.addedAt || existingByPerson?.joinedAt || recoverNow) || recoverNow,
            joinedAt: Number(existingByPerson?.joinedAt || existingByPerson?.addedAt || recoverNow) || recoverNow,
            createdAt: Number(existingByPerson?.createdAt || recoverNow) || recoverNow,
            source: String(existingByPerson?.source || "auto_recover_assigned").trim(),
            tournamentId,
            blockChecked: existingByPerson?.blockChecked === true,
            blockCheckedAt: existingByPerson?.blockCheckedAt ?? null,
            blockAccumulatedMs: Number(existingByPerson?.blockAccumulatedMs || 0) || 0
          };

          const nextRows = [{ ...existingByPerson, ...recoverRow }];
          const { toSet, toDelete } = diffGlobalWaitingRows(prevRows, nextRows);
          for (const { id, data } of toSet) {
            tx.set(globalWaitingDocRef(db, tournamentId, id), data, { merge: true });
          }
          for (const id of toDelete) {
            tx.delete(globalWaitingDocRef(db, tournamentId, id));
          }
        })
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
