import { db } from "../firebase.js";
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

import { mergeOpsProfile, normalizeUserProfile } from "../shared/auth-helpers.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import {
  mergeCheckInRowIntoLocalWaiting,
  upsertCheckInIntoGlobalWaiting
} from "../shared/global-waiting-checkin.js";
import { globalWaitingCollectionRef } from "../shared/tournament-waiting-queue.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { writeIndexGlobalWaitingCache } from "./index-ops-session-cache.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

function indexTournamentMeta() {
  const t = IX.currentTournament;
  return t ? { id: t.id, name: t.name, logoText: t.logoText } : null;
}

function formatCheckInError(error) {
  const code = String(error?.code || "").trim();
  if (code === "permission-denied") {
    return "출근 저장 권한이 없습니다. 로그아웃 후 다시 로그인해 주세요.";
  }
  if (code === "unavailable" || code === "deadline-exceeded") {
    return "네트워크가 불안정합니다. 잠시 후 다시 출근해 주세요.";
  }
  const msg = String(error?.message || "").trim();
  return msg ? `출근 처리 중 오류: ${msg}` : "출근 처리 중 오류가 발생했습니다.";
}

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
    console.warn("isUserAlreadySeated:", err?.code || err);
    return false;
  }
}

function applyOptimisticIndexGlobalWaitingRow(row, tournamentId) {
  if (!row) return;
  IX.globalWaiting = mergeCheckInRowIntoLocalWaiting(IX.globalWaiting, row, tournamentId);
  writeIndexGlobalWaitingCache(tournamentId, IX.globalWaiting);
  scheduleRenderDealerOps();
}

async function appendSelfToGlobalWaiting(user, tournamentId, nickname, email) {
  const uid = String(user?.uid || "").trim();
  const tid = String(tournamentId || "").trim();
  if (!uid || !tid) return false;

  try {
    const { ok, row } = await upsertCheckInIntoGlobalWaiting({
      uid,
      email,
      nickname,
      tournamentId: tid
    });
    if (ok && row) applyOptimisticIndexGlobalWaitingRow(row, tid);
    return ok;
  } catch (err) {
    console.error("appendSelfToGlobalWaiting:", err);
    return false;
  }
}

/**
 * @returns {Promise<boolean|{ ok: boolean, skipWaiting?: boolean }>}
 */
export async function joinSharedWaitingOnCheckIn(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  try {
    const meta = indexTournamentMeta();
    const isOpsUi = canShowTournamentOpsUi(
      user?.email,
      IX.currentUserProfile,
      tournamentId,
      meta,
      user?.uid
    );

    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      alert("유저 프로필을 찾을 수 없습니다. 허브에서 프로필을 먼저 저장해 주세요.");
      return false;
    }

    const rawData = userSnap.data() || {};
    const userProfile = mergeOpsProfile(
      IX.currentUserProfile,
      normalizeUserProfile(rawData, user.email || IX.currentUserProfile?.email || ""),
      userSnap.metadata || {},
      rawData
    );
    if (userProfile) IX.currentUserProfile = userProfile;

    const nickname = String(userProfile.nickname || "").trim();
    const email = String(userProfile.email || user.email || "").trim();
    if (!nickname) {
      alert("닉네임이 없어서 출근할 수 없습니다. 프로필에서 닉네임을 확인해주세요.");
      return false;
    }

    if (isOpsUi) {
      return { ok: true, skipWaiting: true };
    }

    const alreadySeated = await isUserAlreadySeated(user.uid);
    if (alreadySeated) return true;

    const appended = await appendSelfToGlobalWaiting(user, tournamentId, nickname, email);
    if (!appended) {
      alert("대기열 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      return false;
    }

    return true;
  } catch (error) {
    console.error("❌ joinSharedWaitingOnCheckIn error:", error);
    alert(formatCheckInError(error));
    return false;
  }
}

export async function removeFromSharedWaitingOnCheckOut(user) {
  const tournamentId = getTournamentId();
  if (!user || !tournamentId) return false;

  const uid = String(user.uid || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const names = new Set(
    [user.displayName, user.nickname, user.name]
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  );

  try {
    const collRef = globalWaitingCollectionRef(db, tournamentId);
    const refsToDelete = new Map();

    if (uid) {
      const snap = await getDocs(query(collRef, where("uid", "==", uid)));
      snap.docs.forEach((d) => refsToDelete.set(d.ref.path, d.ref));
    }
    if (names.size) {
      const snap = await getDocs(query(collRef, where("name", "in", [...names])));
      snap.docs.forEach((d) => refsToDelete.set(d.ref.path, d.ref));
    }
    if (email) {
      const snap = await getDocs(collRef);
      snap.docs.forEach((d) => {
        const itemEmail = String(d.data()?.email || "").trim().toLowerCase();
        if (itemEmail === email) refsToDelete.set(d.ref.path, d.ref);
      });
    }

    if (!refsToDelete.size) return true;

    const batch = writeBatch(db);
    for (const ref of refsToDelete.values()) batch.delete(ref);
    await batch.commit();

    return true;
  } catch (error) {
    console.error("❌ removeFromSharedWaitingOnCheckOut error:", error);
    alert(formatCheckInError(error).replace("출근", "퇴근"));
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
      return;
    }
    console.error("❌ clearUserSeatNotification error:", error);
  }
}
