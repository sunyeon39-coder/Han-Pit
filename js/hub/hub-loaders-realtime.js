import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  getDocFromServer,
  getDocsFromServer,
  doc,
  onSnapshot,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { normalizeUserProfile } from "../shared/auth-helpers.js";
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

async function readTournamentsSnap() {
  const col = collection(db, "tournaments");
  try {
    return await getDocsFromServer(col);
  } catch {
    return await getDocs(col);
  }
}

function applyTournamentsSnap(snap) {
  if (!snap || snap.empty) {
    hubState.tournamentsCache = [];
    return hubState.tournamentsCache;
  }
  hubState.tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
  return hubState.tournamentsCache;
}

export async function loadTournaments() {
  try {
    const snap = await readTournamentsSnap();
    return applyTournamentsSnap(snap);
  } catch (err) {
    console.error("loadTournaments error:", err);
    if (hubState.tournamentsCache.length) return hubState.tournamentsCache;
    hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
    return hubState.tournamentsCache;
  }
}

export async function loadAllUsers() {
  try {
    const col = collection(db, "users");
    let snap;
    try {
      snap = await getDocsFromServer(col);
    } catch {
      snap = await getDocs(col);
    }
    hubState.usersCache = snap.docs.map(normalizeUserDoc);
    return hubState.usersCache;
  } catch (err) {
    console.error("loadAllUsers error:", err);
    return hubState.usersCache;
  }
}

async function readUserProfileSnap(uid) {
  const userRef = doc(db, "users", uid);
  try {
    return await getDocFromServer(userRef);
  } catch {
    return await getDoc(userRef);
  }
}

function profileFromUserSnap(snap, email = "") {
  if (!snap?.exists()) return null;
  const raw = snap.data() || {};
  const profile = normalizeUserProfile(raw, email);
  const prevRole = String(raw.role || "").trim();
  if (profile.role !== prevRole) {
    void updateDoc(doc(db, "users", snap.id), { role: profile.role }).catch((err) => {
      console.warn("[loadUserProfile] role sync failed:", err);
    });
  }
  return profile;
}

export async function loadUserProfile(uid, email = "") {
  try {
    const snap = await readUserProfileSnap(uid);
    return profileFromUserSnap(snap, email);
  } catch (err) {
    console.error("loadUserProfile error:", err);
    return hubState.currentUserProfile || null;
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

let hubProfileCacheResyncTimer = null;

export function clearHubProfileCacheResyncDebounce() {
  if (hubProfileCacheResyncTimer) {
    clearTimeout(hubProfileCacheResyncTimer);
    hubProfileCacheResyncTimer = null;
  }
}

let hubPeriodicAccessTimer = null;

export function disposeHubPeriodicAccessResync() {
  if (hubPeriodicAccessTimer) {
    clearInterval(hubPeriodicAccessTimer);
    hubPeriodicAccessTimer = null;
  }
}

/** PWA 등에서 리스너가 멈춰도 주기적으로 서버와 맞춤 (일반 유저만) */
export function bindHubPeriodicAccessResync(uid) {
  disposeHubPeriodicAccessResync();
  if (!uid) return;

  hubPeriodicAccessTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (hubState.currentUser?.uid !== uid) return;
    void resyncHubAccessFromServer(uid);
  }, 32000);
}

/** 운영진이 코드·직접 허용을 바꿀 때 허브 카드(접근 제한)가 새로고침 없이 갱신되도록 */
export function bindMyProfileRealtime(uid) {
  if (!uid) return;

  clearHubProfileCacheResyncDebounce();

  if (hubState.stopMyProfileWatch) {
    hubState.stopMyProfileWatch();
    hubState.stopMyProfileWatch = null;
  }
  hubState.hubProfileWatchUid = null;

  hubState.stopMyProfileWatch = onSnapshot(
    doc(db, "users", uid),
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) {
        renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);
        return;
      }

      const patch = normalizeUserProfile(
        snap.data() || {},
        hubState.currentUser?.email || hubState.currentUserProfile?.email || ""
      );
      hubState.currentUserProfile = { ...(hubState.currentUserProfile || {}), ...patch };

      renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);

      const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
      if (isAdmin && hubRefs.adminModal?.classList.contains("show")) {
        populateTournamentSelect();
        renderAdminUserList();
      }

      if (snap.metadata.fromCache) {
        clearHubProfileCacheResyncDebounce();
        hubProfileCacheResyncTimer = setTimeout(() => {
          hubProfileCacheResyncTimer = null;
          void resyncHubAccessFromServer(uid);
        }, 160);
      }
    },
    (err) => {
      console.error("bindMyProfileRealtime error:", err);
    }
  );

  hubState.hubProfileWatchUid = uid;
}

/**
 * 홈 화면(PWA)·사파리 standalone 등에서 백그라운드 후 캐시/리스너가 늦을 때
 * 서버 기준으로 프로필·대회 목록을 다시 읽어 접근 카드를 맞춥니다.
 */
export async function resyncHubAccessFromServer(uid) {
  const user = hubState.currentUser;
  if (!uid || !user?.uid || uid !== user.uid) return;

  try {
    const userRef = doc(db, "users", uid);
    let uSnap;
    try {
      uSnap = await getDocFromServer(userRef);
    } catch {
      uSnap = await getDoc(userRef);
    }

    if (uSnap.exists()) {
      const patch = normalizeUserProfile(
        uSnap.data() || {},
        user.email || hubState.currentUserProfile?.email || ""
      );
      hubState.currentUserProfile = { ...(hubState.currentUserProfile || {}), ...patch };
    }

    const tSnap = await readTournamentsSnap();
    applyTournamentsSnap(tSnap);

    renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);

    const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
    if (isAdmin && hubRefs.adminModal?.classList.contains("show")) {
      populateTournamentSelect();
      renderAdminUserList();
    }
  } catch (err) {
    console.warn("resyncHubAccessFromServer:", err);
  }
}

let hubForegroundResyncDispose = null;

export function disposeHubForegroundAccessResync() {
  if (typeof hubForegroundResyncDispose === "function") {
    hubForegroundResyncDispose();
    hubForegroundResyncDispose = null;
  }
}

/** 앱이 다시 보이거나 네트워크가 돌아올 때 서버와 한 번 맞춤 (새로고침 없는 PWA 대응) */
export function bindHubForegroundAccessResync(uid) {
  disposeHubForegroundAccessResync();
  if (!uid) return;

  const boundAt = Date.now();
  let timer = null;

  const schedule = (immediate) => {
    if (!hubState.currentUser || hubState.currentUser.uid !== uid) return;
    if (document.visibilityState !== "visible") return;

    const elapsed = Date.now() - boundAt;
    if (!immediate && elapsed < 700) return;

    clearTimeout(timer);
    const delay = immediate ? 40 : 280;
    timer = setTimeout(() => {
      timer = null;
      void resyncHubAccessFromServer(uid);
    }, delay);
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") schedule(false);
  };

  const onPageShow = (ev) => {
    if (ev.persisted) schedule(true);
    else if (document.visibilityState === "visible") schedule(false);
  };

  const onOnline = () => schedule(true);
  const onFocus = () => schedule(false);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);

  hubForegroundResyncDispose = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    clearTimeout(timer);
  };
}
