import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  hasAnyDirectEventAllow,
  isSystemAdminEmail,
  mergeAllowedEventsMaps,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  sanitizeAllowedEvents
} from "./auth-helpers.js";
import { readLoginProfileCache, isLoginProfileCacheFresh } from "./login-profile-cache.js";
import { canUseTournamentOps } from "./auth-helpers.js";
import { runFirestoreReadWithRetry } from "./firestore-read-retry.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "./firestore-quota-guard.js";

const profileRefreshInflight = new Map();
const DEFAULT_FIRESTORE_TIMEOUT_MS = 10000;

/** 모바일·오프라인에서 getDocFromServer 가 끝나지 않을 때 UI 멈춤 방지 */
export function raceFirestoreTimeout(promise, ms = DEFAULT_FIRESTORE_TIMEOUT_MS) {
  if (!promise || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(undefined), ms);
    })
  ]);
}

async function readUserDocSnap(uid, options = {}) {
  const forceServer = options.forceServer === true;
  const preferCacheFirst = !forceServer && options.preferCacheFirst !== false;
  const userRef = doc(db, "users", uid);

  const readOnce = async () => {
    if (forceServer) {
      try {
        return await getDocFromServer(userRef);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
        return await getDoc(userRef);
      }
    }
    if (preferCacheFirst) {
      const cached = await getDoc(userRef);
      if (cached.exists()) return cached;
      if (isFirestoreQuotaCoolingDown()) return cached;
      try {
        return await getDocFromServer(userRef);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
        return cached;
      }
    }
    try {
      return await getDocFromServer(userRef);
    } catch (err) {
      noteFirestoreQuotaExceeded(err);
      return await getDoc(userRef);
    }
  };

  if (forceServer) {
    return runFirestoreReadWithRetry(readOnce, { maxAttempts: 2 });
  }
  return readOnce();
}

async function readUsersByEmailVariant(variant, options = {}) {
  const forceServer = options.forceServer === true;
  const preferCacheFirst = !forceServer && options.preferCacheFirst !== false;
  const q = query(collection(db, "users"), where("email", "==", variant), limit(12));

  const readOnce = async () => {
    if (forceServer) {
      try {
        return await getDocsFromServer(q);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
        return await getDocs(q);
      }
    }
    if (preferCacheFirst) {
      const cached = await getDocs(q);
      if (!cached.empty) return cached;
      if (isFirestoreQuotaCoolingDown()) return cached;
      try {
        return await getDocsFromServer(q);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
        return cached;
      }
    }
    try {
      return await getDocsFromServer(q);
    } catch (err) {
      noteFirestoreQuotaExceeded(err);
      return await getDocs(q);
    }
  };

  if (forceServer) {
    return runFirestoreReadWithRetry(readOnce, { maxAttempts: 2 });
  }
  return readOnce();
}

function emailQueryVariants(email = "") {
  const raw = String(email || "").trim();
  const lower = raw.toLowerCase();
  return [...new Set([raw, lower].filter(Boolean))];
}

/** 같은 이메일 users 문서가 여러 uid 로 있어도 **현재 uid 문서** allowedEvents 만 사용 */
export async function loadMergedAllowedEventsByEmail(email = "", primaryUid = "", options = {}) {
  const uid = String(primaryUid || "").trim();
  if (!uid) return {};

  const readOpts = {
    preferCacheFirst: options.preferCacheFirst !== false,
    forceServer: options.forceServer === true
  };

  try {
    const primarySnap = await readUserDocSnap(uid, readOpts);
    if (!primarySnap.exists()) return {};
    const primaryData = primarySnap.data() || {};
    const primaryAllowed = sanitizeAllowedEvents(primaryData.allowedEvents);
    const primaryRole = String(primaryData.role || "user").trim().toLowerCase();
    if (primaryRole !== "admin" && !hasAnyDirectEventAllow(primaryAllowed)) {
      return {};
    }
    return primaryAllowed;
  } catch (err) {
    console.warn("[loadMergedAllowedEventsByEmail] primary uid read failed:", err);
    return {};
  }
}

function scheduleProfileServerRefresh(uid = "", email = "") {
  const id = String(uid || "").trim();
  if (!id || isFirestoreQuotaCoolingDown()) return;
  if (profileRefreshInflight.has(id)) return;
  const task = loadUserProfileFresh(id, email, {
    preferCacheFirst: true,
    skipLoginCache: true
  }).finally(() => {
    profileRefreshInflight.delete(id);
  });
  profileRefreshInflight.set(id, task);
}

/** allowedEvents 등 운영 권한 판별용 — 기본은 캐시 우선(빠른 부트), 서버 재검증은 백그라운드 */
export async function loadUserProfileFresh(uid, email = "", options = {}) {
  const preferCacheFirst = options.preferCacheFirst !== false;
  const skipLoginCache = options.skipLoginCache === true;
  const mergeEmailAllows = options.mergeEmailAllows !== false;
  const allowMissingDoc = options.allowMissingDoc !== false;
  const deferEmailMerge = options.deferEmailMerge === true;

  if (preferCacheFirst && !skipLoginCache && uid && isLoginProfileCacheFresh(uid)) {
    const loginCached = readLoginProfileCache(uid);
    const emailLc = String(email || "").trim().toLowerCase();
    const cachedEmailLc = String(loginCached?.email || "").trim().toLowerCase();
    const cachedHasOps =
      !isSystemAdminEmail(emailLc || cachedEmailLc) &&
      hasAnyDirectEventAllow(sanitizeAllowedEvents(loginCached?.allowedEvents));
    if (
      loginCached &&
      (!emailLc || !cachedEmailLc || emailLc === cachedEmailLc) &&
      !cachedHasOps
    ) {
      scheduleProfileServerRefresh(uid, email);
      return loginCached;
    }
  }

  let snap = null;
  if (uid) {
    snap = await readUserDocSnap(uid, { preferCacheFirst });
  }

  const raw = snap?.exists() ? snap.data() || {} : {};
  const resolvedEmail = email || raw.email || "";
  let profile = normalizeUserProfile(
    snap?.exists()
      ? raw
      : {
          email: resolvedEmail,
          nickname: "",
          accessCode: "",
          role: "user"
        },
    resolvedEmail
  );

  if (mergeEmailAllows && resolvedEmail && !deferEmailMerge) {
    const mergedAllowed = await loadMergedAllowedEventsByEmail(resolvedEmail, uid, {
      preferCacheFirst
    });
    if (Object.keys(mergedAllowed).length > 0) {
      profile = normalizeUserProfile({ ...profile, allowedEvents: mergedAllowed }, resolvedEmail);
    }
  } else if (mergeEmailAllows && resolvedEmail && deferEmailMerge) {
    void loadMergedAllowedEventsByEmail(resolvedEmail, uid, { preferCacheFirst: false }).then(
      (mergedAllowed) => {
        if (Object.keys(mergedAllowed).length > 0) {
          scheduleProfileServerRefresh(uid, resolvedEmail);
        }
      }
    );
  }

  if (!snap?.exists() && !allowMissingDoc) return null;
  if (!snap?.exists() && !hasAnyDirectEventAllow(profile.allowedEvents) && !profile.nickname) {
    return null;
  }

  return profile;
}

/** 같은 이메일 다른 uid 문서의 allowedEvents 를 프로필에 합침 */
export async function enrichProfileWithEmailAllows(uid, email, profile, options = {}) {
  if (!profile || typeof profile !== "object") return profile;
  const resolvedEmail = String(email || profile.email || "").trim();
  if (!resolvedEmail) return profile;

  const mailLc = resolvedEmail.toLowerCase();
  const primaryRole = String(profile.role || "user").trim().toLowerCase();
  const primaryAllowed = sanitizeAllowedEvents(profile.allowedEvents);
  if (
    !isSystemAdminEmail(mailLc) &&
    primaryRole !== "admin" &&
    !hasAnyDirectEventAllow(primaryAllowed)
  ) {
    return profile;
  }

  const mergedAllowed = await loadMergedAllowedEventsByEmail(resolvedEmail, uid, {
    preferCacheFirst: options.preferCacheFirst !== false,
    forceServer: options.forceServer === true
  });
  if (!Object.keys(mergedAllowed).length) return profile;
  return normalizeUserProfile({ ...profile, allowedEvents: mergedAllowed }, resolvedEmail);
}

/** index·통합배치도 — 모바일 포함 서버·이메일 병합만 사용 (로컬 캐시 우회) */
export async function loadUserProfileForTournamentOps(uid, email = "", tournamentId = "", options = {}) {
  const tid = String(tournamentId || "").trim();
  const tournamentMeta = options.tournamentMeta || null;
  const preferCacheFirst = options.preferCacheFirst === true;
  const readOpts = preferCacheFirst
    ? { preferCacheFirst: true, skipLoginCache: true, mergeEmailAllows: true }
    : { preferCacheFirst: false, skipLoginCache: true, forceServer: true, mergeEmailAllows: true };
  const enrichOpts = preferCacheFirst
    ? { preferCacheFirst: true, forceServer: false }
    : { preferCacheFirst: false, forceServer: true };

  let profile = await raceFirestoreTimeout(loadUserProfileFresh(uid, email, readOpts));
  profile =
    (await raceFirestoreTimeout(enrichProfileWithEmailAllows(uid, email, profile, enrichOpts))) ||
    profile;

  if (!profile && uid) {
    profile = await loadUserProfileFresh(uid, email, {
      preferCacheFirst: true,
      skipLoginCache: true
    });
  }

  if (!tid || !profile) return profile;
  if (canUseTournamentOps(email, profile, tid, tournamentMeta)) return profile;
  if (preferCacheFirst) return profile;

  const fresh = await raceFirestoreTimeout(loadUserProfileFresh(uid, email, readOpts), 6000);
  profile =
    (await raceFirestoreTimeout(
      enrichProfileWithEmailAllows(uid, email, fresh || profile, enrichOpts),
      6000
    )) || profile;
  return profile;
}

/** 허브 — allowedEvents 를 서버·이메일 병합으로 재검증 */
export async function loadUserProfileRevalidated(uid, email = "") {
  let profile = await loadUserProfileFresh(uid, email, {
    preferCacheFirst: false,
    skipLoginCache: true
  });
  return enrichProfileWithEmailAllows(uid, email, profile, { preferCacheFirst: false });
}
