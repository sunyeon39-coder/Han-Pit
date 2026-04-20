import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";

/* ===============================
   SHARED WAITING & SEAT CLEAR
=============================== */
async function isUserAlreadySeated(userUid) {
  if (!userUid) return false;

  try {
    const snap = await getDocs(collection(db, "layout_events"));

    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const seats = Array.isArray(data.seats) ? data.seats : [];

      const found = seats.some((seat) => {
        if (!seat || typeof seat !== "object") return false;
        return String(seat.personUid || "").trim() === String(userUid).trim();
      });

      if (found) return true;
    }

    return false;
  } catch (err) {
    console.error("❌ isUserAlreadySeated error:", err);
    return false;
  }
}

export async function joinSharedWaitingOnCheckIn(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) return false;

    const userProfile = userSnap.data() || {};
    IX.currentUserProfile = userProfile;

    if (getIsAdmin(user, userProfile)) return false;

    const nickname = String(userProfile.nickname || "").trim();
    const email = String(userProfile.email || user.email || "").trim();
    if (!nickname) {
      alert("닉네임이 없어서 출근할 수 없습니다. 프로필에서 닉네임을 확인해주세요.");
      return false;
    }

    const alreadySeated = await isUserAlreadySeated(user.uid);
    if (alreadySeated) return true;

    const waitingRef = doc(db, "layout_shared", "global_waiting");

    await runTransaction(db, async (tx) => {
      const waitingSnap = await tx.get(waitingRef);
      const waitingState = waitingSnap.exists()
        ? (waitingSnap.data() || {})
        : { version: 2, waiting: [], updatedAt: Date.now() };

      const waitingList = Array.isArray(waitingState.waiting)
        ? [...waitingState.waiting]
        : [];

      const alreadyInWaiting = waitingList.some((item) => {
        if (!item || typeof item !== "object") return false;
        const itemUid = String(item.uid || "").trim();
        const itemTournamentId = String(item.tournamentId || "").trim();
        if (itemUid !== String(user.uid).trim()) return false;
        // Same user can exist in another tournament waiting list.
        // Block only when this tournament already has the user.
        if (!itemTournamentId) return true;
        return itemTournamentId === tournamentId;
      });

      if (alreadyInWaiting) return;

      waitingList.push({
        id: `w_${user.uid}`,
        uid: user.uid,
        email,
        name: nickname,
        addedAt: Date.now(),
        source: "checkin",
        tournamentId
      });

      tx.set(
        waitingRef,
        {
          ...waitingState,
          version: 2,
          waiting: waitingList,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    });

    return true;
  } catch (error) {
    console.error("❌ joinSharedWaitingOnCheckIn error:", error);
    alert("출근 처리 중 오류가 발생했습니다.");
    return false;
  }
}

export async function removeFromSharedWaitingOnCheckOut(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  try {
    const waitingRef = doc(db, "layout_shared", "global_waiting");

    await runTransaction(db, async (tx) => {
      const waitingSnap = await tx.get(waitingRef);
      if (!waitingSnap.exists()) return;

      const waitingState = waitingSnap.data() || {};
      const waitingList = Array.isArray(waitingState.waiting)
        ? waitingState.waiting
        : [];

      const nextWaiting = waitingList.filter((item) => {
        if (!item || typeof item !== "object") return false;

        const itemUid = String(item.uid || "").trim();
        const itemTournamentId = String(item.tournamentId || "").trim();

        if (itemUid !== String(user.uid || "").trim()) return true;
        if (itemTournamentId && itemTournamentId !== tournamentId) return true;

        return false;
      });

      tx.set(
        waitingRef,
        {
          ...waitingState,
          version: 2,
          waiting: nextWaiting,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    });

    return true;
  } catch (error) {
    console.error("❌ removeFromSharedWaitingOnCheckOut error:", error);
    alert("퇴근 처리 중 오류가 발생했습니다.");
    return false;
  }
}

export async function removeUserFromAllSeatsGlobal(user) {
  if (!user?.uid) return 0;

  try {
    const snap = await getDocs(collection(db, "layout_events"));
    let removedCount = 0;

    await Promise.all(
      snap.docs.map(async (docSnap) => {
        const data = docSnap.data() || {};
        const seats = Array.isArray(data.seats) ? data.seats : [];
        let changed = false;

        const nextSeats = seats.map((seat) => {
          if (!seat || typeof seat !== "object") return seat;

          const personUid = String(seat.personUid || "").trim();
          if (personUid !== String(user.uid).trim()) return seat;

          changed = true;
          removedCount += 1;

          return {
            ...seat,
            person: "비어있음",
            personUid: "",
            personEmail: "",
            seatedAt: null
          };
        });

        if (!changed) return;

        await setDoc(
          docSnap.ref,
          {
            ...data,
            seats: nextSeats,
            updatedAt: Date.now()
          },
          { merge: true }
        );
      })
    );

    return removedCount;
  } catch (error) {
    if (String(error?.code || "").includes("permission-denied")) {
      // Normal user checkout path can hit admin-only seat docs.
      return 0;
    }
    console.error("❌ removeUserFromAllSeatsGlobal error:", error);
    return 0;
  }
}

export async function clearUserSeatNotification(uid) {
  if (!uid) return;

  try {
    await setDoc(
      doc(db, "layout_notifications", uid),
      {
        type: "seat_cleared",
        acknowledged: true,
        seatId: "",
        seatLabel: "",
        eventId: "",
        eventTitle: "",
        boxId: "",
        targetUrl: "",
        message: "",
        updatedAt: Date.now()
      },
      { merge: true }
    );
  } catch (error) {
    if (String(error?.code || "").includes("permission-denied")) {
      // layout_notifications write is admin-only except acknowledgement-only updates.
      return;
    }
    console.error("❌ clearUserSeatNotification error:", error);
  }
}
