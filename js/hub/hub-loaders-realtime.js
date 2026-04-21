import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  normalizeTournamentDoc,
  normalizeUserDoc,
  sortTournaments,
  getIsAdminUser
} from "./hub-helpers.js";
import { hubState, FALLBACK_TOURNAMENTS } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { renderTournaments } from "./hub-tournament-list.js";
import { populateTournamentSelect, renderAdminUserList } from "./hub-admin-ui.js";

export async function loadTournaments() {
  try {
    const snap = await getDocs(collection(db, "tournaments"));

    if (snap.empty) {
      hubState.tournamentsCache = [];
      return hubState.tournamentsCache;
    }

    hubState.tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
    return hubState.tournamentsCache;
  } catch (err) {
    console.error("loadTournaments error:", err);
    hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
    return hubState.tournamentsCache;
  }
}

export async function loadAllUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    hubState.usersCache = snap.docs.map(normalizeUserDoc);
    return hubState.usersCache;
  } catch (err) {
    console.error("loadAllUsers error:", err);
    return hubState.usersCache;
  }
}

export async function loadUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    console.error("loadUserProfile error:", err);
    return null;
  }
}

export function bindTournamentsRealtime() {
  if (hubState.stopTournamentsWatch) {
    hubState.stopTournamentsWatch();
    hubState.stopTournamentsWatch = null;
  }

  hubState.stopTournamentsWatch = onSnapshot(
    collection(db, "tournaments"),
    (snap) => {
      if (snap.empty) {
        hubState.tournamentsCache = [];
      } else {
        hubState.tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
      }

      renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);

      if (
        getIsAdminUser(hubState.currentUser, hubState.currentUserProfile) &&
        hubRefs.adminModal?.classList.contains("show")
      ) {
        populateTournamentSelect();
        renderAdminUserList();
      }
    },
    (err) => {
      console.error("bindTournamentsRealtime error:", err);
      hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
      renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);
    }
  );
}

export function bindUsersRealtime() {
  if (hubState.stopUsersWatch) {
    hubState.stopUsersWatch();
    hubState.stopUsersWatch = null;
  }

  hubState.stopUsersWatch = onSnapshot(
    collection(db, "users"),
    (snap) => {
      hubState.usersCache = snap.docs.map(normalizeUserDoc);
      if (getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
        renderAdminUserList();
      }
    },
    (err) => {
      console.error("bindUsersRealtime error:", err);
    }
  );
}

/** 운영진이 코드·직접 허용을 바꿀 때 허브 카드(접근 제한)가 새로고침 없이 갱신되도록 */
export function bindMyProfileRealtime(uid) {
  if (!uid) return;

  if (hubState.stopMyProfileWatch) {
    hubState.stopMyProfileWatch();
    hubState.stopMyProfileWatch = null;
  }

  hubState.stopMyProfileWatch = onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (!snap.exists()) return;

      const patch = snap.data() || {};
      hubState.currentUserProfile = { ...(hubState.currentUserProfile || {}), ...patch };

      renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);

      const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
      if (isAdmin && hubRefs.adminModal?.classList.contains("show")) {
        populateTournamentSelect();
        renderAdminUserList();
      }
    },
    (err) => {
      console.error("bindMyProfileRealtime error:", err);
    }
  );
}
