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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  buildDirectOpsPersistPatch,
  mergeOpsProfile,
  normalizeUserProfile,
  resolveDirectOpsRole,
  sanitizeAllowedEvents
} from "../shared/auth-helpers.js";
import {
  enrichProfileWithEmailAllows,
  loadUserProfileFresh,
  loadUserProfileRevalidated
} from "../shared/load-user-profile.js";
import { writeLoginProfileCache } from "../shared/login-profile-cache.js";
import { syncLoginCacheForOpsProfile } from "../shared/tournament-ops-access.js";
import {
  normalizeTournamentDoc,
  normalizeUserDoc,
  sortTournaments,
  getIsAdminUser,
  userRecordHasDirectOpsAllow
} from "./hub-helpers.js";
import { isSystemAdminEmail } from "../shared/auth-helpers.js";
import { applyHubOpsChrome } from "./hub-ops-chrome.js";
import { hubState, FALLBACK_TOURNAMENTS } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { scheduleHubTournamentsRender, scheduleHubAdminRender } from "./hub-realtime-ui.js";
import { populateTournamentSelect } from "./hub-admin-ui.js";
import {
  readHubTournamentsSessionCache,
  writeHubTournamentsSessionCache
} from "./hub-tournaments-session-cache.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";

/** 오프라인·PWA에서 빈 캐시 스냅샷이 서버로 읽은 목록을 지우는 것을 막음 */
function shouldSkipEmptyCacheSnapshot(snap, cachedCount = 0) {
  return Boolean(snap?.empty && snap.metadata?.fromCache && cachedCount > 0);
}

async function readTournamentsSnap() {
  const col = collection(db, "tournaments");
  if (isFirestoreQuotaCoolingDown()) {
    return getDocs(col);
  }
  const cacheSnap = await getDocs(col);
  if (!cacheSnap.empty || hubState.stopTournamentsWatch) return cacheSnap;
  try {
    return await getDocsFromServer(col);
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("readTournamentsSnap server:", err?.code || err);
    return cacheSnap;
  }
}

async function refreshTournamentsFromServer() {
  if (hubState.stopTournamentsWatch || isFirestoreQuotaCoolingDown()) return;
  try {
    const serverSnap = await getDocsFromServer(collection(db, "tournaments"));
    if (serverSnap.empty) return;
    applyTournamentsSnap(serverSnap);
    hubState.tournamentsListReady = true;
    scheduleHubTournamentsRender();
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshTournamentsFromServer:", err?.code || err);
  }
}

/** 허브 부트 직후 캐시만으로 목록을 먼저 그립니다. */
export function prefetchHubTournamentsCache() {
  return getDocs(collection(db, "tournaments"))
    .then((snap) => {
      if (shouldSkipEmptyCacheSnapshot(snap, hubState.tournamentsCache.length)) return;
      if (!snap.empty) {
        applyTournamentsSnap(snap);
        hubState.tournamentsListReady = true;
        scheduleHubTournamentsRender();
      }
    })
    .catch((err) => {
      console.warn("prefetchHubTournamentsCache:", err?.code || err);
    });
}

function applyTournamentsSnap(snap) {
  if (!snap || snap.empty) {
    if (hubState.tournamentsCache.length > 0 && snap?.metadata?.fromCache) {
      return hubState.tournamentsCache;
    }
    hubState.tournamentsCache = [];
    return hubState.tournamentsCache;
  }
  hubState.tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
  writeHubTournamentsSessionCache(hubState.tournamentsCache);
  return hubState.tournamentsCache;
}

/** 허브 진입 직후 sessionStorage 목록으로 즉시 카드 표시 */
export function seedHubTournamentsFromSessionCache() {
  const cached = readHubTournamentsSessionCache();
  if (!cached?.length) return false;
  hubState.tournamentsCache = sortTournaments(cached);
  hubState.tournamentsListReady = true;
  return true;
}

export async function loadTournaments() {
  try {
    const snap = await readTournamentsSnap();
    applyTournamentsSnap(snap);
    hubState.tournamentsListReady = true;
    if (snap.metadata?.fromCache && !snap.empty) {
      void refreshTournamentsFromServer();
    }
    return hubState.tournamentsCache;
  } catch (err) {
    console.error("loadTournaments error:", err);
    hubState.tournamentsListReady = true;
    if (hubState.tournamentsCache.length) return hubState.tournamentsCache;
    hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
    writeHubTournamentsSessionCache(hubState.tournamentsCache);
    return hubState.tournamentsCache;
  }
}

/** 직접 허용 유저는 role 이 user 로 깨져도 admin + allowedEvents 를 서버에 유지 */
async function reconcileDirectAllowOpsOnServer(users = []) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return { fixed: 0 };

  let fixed = 0;
  for (const u of users || []) {
    if (!u?.uid || isSystemAdminEmail(u.email)) continue;
    if (!userRecordHasDirectOpsAllow(u)) continue;

    const patch = buildDirectOpsPersistPatch(
      {
        role: u._rawRole || u.role,
        allowedEvents: u._rawAllowedEvents ?? u.allowedEvents,
        opsTournamentIds: u._rawOpsTournamentIds,
        email: u.email
      },
      u.email
    );
    if (!patch) continue;

    const rawRole = String(u._rawRole || u.role || "")
      .trim()
      .toLowerCase();
    const rawAllowed = sanitizeAllowedEvents(u._rawAllowedEvents || {});
    const needsRole = rawRole !== "admin";
    const needsEvents =
      Object.keys(rawAllowed).length < Object.keys(patch.allowedEvents || {}).length;

    if (!needsRole && !needsEvents) continue;

    try {
      await updateDoc(doc(db, "users", u.uid), patch);
      u.role = "admin";
      u._rawRole = "admin";
      u.allowedEvents = patch.allowedEvents;
      u._rawAllowedEvents = { ...patch.allowedEvents };
      u._rawOpsTournamentIds = patch.opsTournamentIds;
      fixed += 1;
    } catch (err) {
      console.warn("[reconcileDirectAllowOpsOnServer]", u.uid, err?.code || err);
    }
  }
  return { fixed };
}

/** allowedEvents 없는데 opsTournamentIds·role admin 만 남은 문서 정리 */
async function pruneStaleOpsTournamentIdsOnServer(users = []) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
    return { fixed: 0 };
  }

  let fixed = 0;
  for (const u of users || []) {
    if (!u?.uid || isSystemAdminEmail(u.email)) continue;

    const rawAllowed = sanitizeAllowedEvents(u._rawAllowedEvents ?? {});
    const expectedOps = Object.keys(rawAllowed);
    const rawOps = Array.isArray(u._rawOpsTournamentIds)
      ? u._rawOpsTournamentIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const roleWant = resolveDirectOpsRole(u.email, rawAllowed);
    const rawRole = String(u._rawRole || u.role || "")
      .trim()
      .toLowerCase();

    const opsStale =
      rawOps.length !== expectedOps.length ||
      expectedOps.some((id) => !rawOps.includes(id)) ||
      rawOps.some((id) => !rawAllowed[id]);
    const roleStale = rawRole !== roleWant;

    if (!opsStale && !roleStale) continue;

    try {
      await updateDoc(doc(db, "users", u.uid), {
        allowedEvents: rawAllowed,
        opsTournamentIds: expectedOps,
        role: roleWant
      });
      u.allowedEvents = rawAllowed;
      u._rawAllowedEvents = { ...rawAllowed };
      u._rawOpsTournamentIds = expectedOps;
      u.role = roleWant;
      u._rawRole = roleWant;
      fixed += 1;
    } catch (err) {
      console.warn("[pruneStaleOpsTournamentIdsOnServer]", u.uid, err?.code || err);
    }
  }
  return { fixed };
}

function healStaleUserRolesFromCache(users = []) {
  for (const u of users) {
    if (!u?.uid) continue;
    if (userRecordHasDirectOpsAllow(u)) continue;

    const raw = String(u._rawRole || "")
      .trim()
      .toLowerCase();
    const resolved = String(u.role || "user")
      .trim()
      .toLowerCase();
    if (!raw || raw === resolved) continue;
    if (raw === "admin" && resolved === "user") continue;
    if (resolved !== "admin") continue;

    void updateDoc(doc(db, "users", u.uid), { role: "admin" }).catch((err) => {
      console.warn("[healStaleUserRole]", u.uid, err?.code || err);
    });
  }
}

/** 시스템 admin 세션 — admin 이메일이 아닌데 role 이 admin 으로 남은 문서만 정리 (직접 허용 allowedEvents 는 유지) */
export async function healNonAdminUsersToBasic(users = [], options = {}) {
  const stripAllowedEvents = options.stripAllowedEvents === true;
  if (!stripAllowedEvents) {
    return { fixed: 0, skipped: true };
  }
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
    return { fixed: 0, skipped: true };
  }
  if (hubState.usersRoleHealInFlight) return { fixed: 0, skipped: true };

  const toFix = (users || []).filter((u) => {
    if (!u?.uid) return false;
    if (isSystemAdminEmail(u.email)) return false;
    if (userRecordHasDirectOpsAllow(u)) return false;

    const rawRole = String(u._rawRole || u.role || "")
      .trim()
      .toLowerCase();
    if (rawRole !== "admin") {
      if (stripAllowedEvents) {
        const rawAllowed = sanitizeAllowedEvents(u._rawAllowedEvents || u.allowedEvents);
        return Object.keys(rawAllowed).length > 0;
      }
      return false;
    }
    const rawAllowed = sanitizeAllowedEvents(u._rawAllowedEvents || u.allowedEvents);
    if (Object.keys(rawAllowed).length > 0) return false;
    return true;
  });

  if (!toFix.length) return { fixed: 0 };

  hubState.usersRoleHealInFlight = true;
  let fixed = 0;
  try {
    for (const u of toFix) {
      const updates = { role: "user" };
      if (stripAllowedEvents) {
        updates.allowedEvents = {};
      }
      await updateDoc(doc(db, "users", u.uid), updates);
      u.role = "user";
      u._rawRole = "user";
      if (stripAllowedEvents) {
        u.allowedEvents = {};
        u._rawAllowedEvents = {};
      }
      fixed += 1;
    }
  } catch (err) {
    console.error("[healNonAdminUsersToBasic] error:", err);
    throw err;
  } finally {
    hubState.usersRoleHealInFlight = false;
  }

  return { fixed };
}

function healStaleAllowedEventsFromCache(users = []) {
  for (const u of users) {
    if (!u?.uid) continue;
    if (userRecordHasDirectOpsAllow(u)) continue;

    const raw = u._rawAllowedEvents;
    if (!raw || typeof raw !== "object") continue;
    const sanitized = sanitizeAllowedEvents(raw);
    const rawKeys = Object.keys(raw);
    const sanKeys = Object.keys(sanitized);
    if (rawKeys.length > 0 && sanKeys.length === 0) continue;
    const mismatch =
      rawKeys.length !== sanKeys.length ||
      rawKeys.some((k) => raw[k] === true && !sanitized[k]) ||
      rawKeys.some((k) => raw[k] !== true && raw[k] != null);
    if (!mismatch) continue;
    void updateDoc(doc(db, "users", u.uid), { allowedEvents: sanitized }).catch((err) => {
      console.warn("[healStaleAllowedEvents]", u.uid, err?.code || err);
    });
  }
}

export async function loadAllUsers() {
  if (isFirestoreQuotaCoolingDown()) {
    return hubState.usersCache;
  }
  try {
    const col = collection(db, "users");
    let snap = await getDocs(col);
    if (snap.empty && !hubState.stopUsersWatch) {
      try {
        snap = await getDocsFromServer(col);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
      }
    }
    hubState.usersCache = snap.docs.map(normalizeUserDoc);
    healStaleUserRolesFromCache(hubState.usersCache);
    healStaleAllowedEventsFromCache(hubState.usersCache);
    if (!hubState.usersRoleHealDone) {
      hubState.usersRoleHealDone = true;
      void Promise.all([
        reconcileDirectAllowOpsOnServer(hubState.usersCache),
        pruneStaleOpsTournamentIdsOnServer(hubState.usersCache)
      ])
        .then(([recon, pruned]) => {
          if (recon.fixed > 0) {
            console.info(
              `[reconcileDirectAllowOpsOnServer] 직접 허용 ${recon.fixed}명 role/allowedEvents 복구`
            );
          }
          if (pruned.fixed > 0) {
            console.info(
              `[pruneStaleOpsTournamentIdsOnServer] stale ops/role ${pruned.fixed}명 정리`
            );
            scheduleHubAdminRender();
          }
        })
        .catch((err) => {
          console.error("direct-allow reconcile/prune on loadAllUsers:", err);
        });
    }
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
  return normalizeUserProfile(snap.data() || {}, email);
}

export async function loadUserProfile(uid, email = "") {
  try {
    return await loadUserProfileRevalidated(uid, email);
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
      if (shouldSkipEmptyCacheSnapshot(snap, hubState.tournamentsCache.length)) return;

      if (snap.empty) {
        if (shouldSkipEmptyCacheSnapshot(snap, hubState.tournamentsCache.length)) return;
        if (snap.metadata?.fromCache) return;
        hubState.tournamentsCache = [];
        hubState.tournamentsListReady = true;
      } else {
        hubState.tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
        hubState.tournamentsListReady = true;
        writeHubTournamentsSessionCache(hubState.tournamentsCache);
      }

      scheduleHubTournamentsRender();

      if (
        getIsAdminUser(hubState.currentUser, hubState.currentUserProfile) &&
        hubRefs.adminModal?.classList.contains("show")
      ) {
        populateTournamentSelect();
        scheduleHubAdminRender();
      }
    },
    (err) => {
      console.error("bindTournamentsRealtime error:", err);
      hubState.tournamentsCache = sortTournaments(FALLBACK_TOURNAMENTS);
      hubState.tournamentsListReady = true;
      hubState.tournamentsBootstrapping = false;
      writeHubTournamentsSessionCache(hubState.tournamentsCache);
      scheduleHubTournamentsRender();
    }
  );
}

export function disposeUsersRealtime() {
  if (hubState.stopUsersWatch) {
    hubState.stopUsersWatch();
    hubState.stopUsersWatch = null;
  }
}

export function bindUsersRealtime() {
  if (hubState.stopUsersWatch) {
    hubState.stopUsersWatch();
    hubState.stopUsersWatch = null;
  }

  hubState.stopUsersWatch = onSnapshot(
    collection(db, "users"),
    (snap) => {
      if (shouldSkipEmptyCacheSnapshot(snap, hubState.usersCache.length)) return;

      hubState.usersCache = snap.docs.map(normalizeUserDoc);
      scheduleHubAdminRender();
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

/** PWA 등에서 리스너가 멈춰도 주기적으로 서버와 맞춤 — quota 절약을 위해 간격을 길게 */
export function bindHubPeriodicAccessResync(uid) {
  disposeHubPeriodicAccessResync();
  if (!uid) return;

  hubPeriodicAccessTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (hubState.currentUser?.uid !== uid) return;
    void resyncHubAccessFromServer(uid);
  }, 5 * 60_000);
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
    (snap) => {
      if (!snap.exists()) {
        if (snap.metadata?.fromCache && hubState.currentUserProfile) return;
        scheduleHubTournamentsRender();
        return;
      }

      const email =
        hubState.currentUser?.email || hubState.currentUserProfile?.email || "";
      const merged = mergeOpsProfile(
        hubState.currentUserProfile,
        normalizeUserProfile(snap.data() || {}, email),
        snap.metadata || {}
      );
      const fromCache = snap.metadata?.fromCache === true;
      void enrichProfileWithEmailAllows(uid, email, merged, { preferCacheFirst: fromCache }).then(
        (profile) => {
          hubState.currentUserProfile = { ...(hubState.currentUserProfile || {}), ...profile };
          syncLoginCacheForOpsProfile(uid, hubState.currentUserProfile);
          applyHubOpsChrome(hubState.currentUser);
          scheduleHubTournamentsRender();

          const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
          if (isAdmin && hubRefs.adminModal?.classList.contains("show")) {
            populateTournamentSelect();
            scheduleHubAdminRender();
          }
        }
      );

      if (snap.metadata.fromCache) {
        /* onSnapshot + resyncHubAccessFromServer(90s) 로 충분 — 캐시마다 forceServer resync 제거 */
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
export async function resyncHubAccessFromServer(uid, options = {}) {
  const user = hubState.currentUser;
  if (!uid || !user?.uid || uid !== user.uid) return;
  if (isFirestoreQuotaCoolingDown()) return;

  const force = options.force === true;
  const now = Date.now();
  if (!force && now - lastHubAccessResyncAt < HUB_ACCESS_RESYNC_MIN_MS) return;
  lastHubAccessResyncAt = now;

  try {
    const profile = await loadUserProfileFresh(uid, user.email || "", {
      preferCacheFirst: true,
      skipLoginCache: false
    });
    if (profile) {
      hubState.currentUserProfile = profile;
      writeLoginProfileCache(uid, profile);
      applyHubOpsChrome(user);
    }

    if (!hubState.stopTournamentsWatch) {
      const tSnap = await readTournamentsSnap();
      applyTournamentsSnap(tSnap);
      scheduleHubTournamentsRender();
    }

    const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
    if (isAdmin && hubRefs.adminModal?.classList.contains("show")) {
      populateTournamentSelect();
      scheduleHubAdminRender();
    }
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("resyncHubAccessFromServer:", err?.code || err);
  }
}

let hubForegroundResyncDispose = null;
let lastHubAccessResyncAt = 0;
const HUB_ACCESS_RESYNC_MIN_MS = 90_000;

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
    if (!immediate && elapsed < 4000) return;

    clearTimeout(timer);
    const delay = immediate ? 500 : 2000;
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

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);

  hubForegroundResyncDispose = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
    clearTimeout(timer);
  };
}
