/**
 * layout.html: Seat 해제/배치 시 딜러를 대기열로 옮기거나 출석 상태를 assigned로 반영
 */
import { db } from "../firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function createLayoutDealerMoves(deps) {
  const {
    TOURNAMENT_ID,
    waitingState,
    getIdentityKey,
    getWaitingIdentity,
    makeUid,
    touchWaiting,
    setDealerStatus,
    getBestDisplayName,
    removeWaitingEntriesByIdentity
  } = deps;

  async function moveDealerToWaiting(meta = {}) {
    const uid = String(meta.uid || "").trim();
    const email = String(meta.email || "").trim();
    let nickname = String(meta.nickname || "").trim();

    const carryStartedAt = meta.carryStartedAt ? Number(meta.carryStartedAt) : null;

    if (!nickname && uid) {
      try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) {
          const data = snap.data() || {};
          nickname = String(data.nickname || "").trim();
        }
      } catch (e) {
        console.error("nickname fetch error", e);
      }
    }

    if (!nickname) {
      nickname = email || "Dealer";
    }

    if (!uid && !nickname) return;

    const identityKey = getIdentityKey({
      uid,
      email,
      name: nickname
    });

    const exists = waitingState.waiting.some((w) => {
      return getWaitingIdentity(w) === identityKey;
    });

    if (!exists) {
      waitingState.waiting.push({
        id: makeUid("wait"),
        name: nickname,
        uid,
        email,
        tournamentId: TOURNAMENT_ID,
        addedAt: Date.now(),
        carryStartedAt: carryStartedAt || null
      });
      touchWaiting(true);
    }

    if (uid) {
      await setDealerStatus(uid, {
        email,
        nickname,
        status: "waiting",
        currentEventId: "",
        currentBoxId: "",
        currentSeatId: "",
        currentSeatLabel: ""
      });
    }
  }

  async function moveDealerToAssigned({
    uid = "",
    email = "",
    name = "",
    seatId = "",
    seatLabel = "",
    eventId = "",
    boxId = "",
    resolvedDisplayName = null
  }) {
    if (!uid && !name && !email) return;

    const trimmedResolved =
      resolvedDisplayName != null ? String(resolvedDisplayName).trim() : "";
    const displayName = trimmedResolved
      ? trimmedResolved
      : await getBestDisplayName(uid, email, name);
    const identityKey = getIdentityKey({
      uid,
      email,
      name: displayName
    });

    if (identityKey) {
      removeWaitingEntriesByIdentity(identityKey);
    } else {
      waitingState.waiting = waitingState.waiting.filter((w) => {
        if (!w || typeof w !== "object") return false;
        return String(w.uid || "").trim() !== String(uid).trim();
      });
    }

    touchWaiting(true);

    if (uid) {
      await setDealerStatus(uid, {
        email: String(email || "").trim(),
        nickname: String(displayName || "").trim(),
        status: "assigned",
        currentEventId: String(eventId || "").trim(),
        currentBoxId: String(boxId || "").trim(),
        currentSeatId: String(seatId || "").trim(),
        currentSeatLabel: String(seatLabel || "").trim()
      });
    }
  }

  return { moveDealerToWaiting, moveDealerToAssigned };
}
