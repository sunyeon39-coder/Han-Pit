import { db } from "../firebase.js";
import { enableNetwork } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  hasAnyDirectEventAllow,
  mergeAllowedEventsMaps,
  normalizeUserProfile,
  opsAllowedEventsFromProfile
} from "./auth-helpers.js";
import { readLoginProfileCache, isLoginProfileCacheFresh } from "./login-profile-cache.js";
import { canUseTournamentOps } from "./auth-helpers.js";

const profileRefreshInflight = new Map();

async function readUserDocSnap(uid, options = {}) {
  const forceServer = options.forceServer === true;
  const preferCacheFirst = !forceServer && options.preferCacheFirst !== false;
  const userRef = doc(db, "users", uid);
  if (forceServer) {
    try {
      return await getDocFromServer(userRef);
    } catch {
      return await getDoc(userRef);
    }
  }
  if (preferCacheFirst) {
    const cached = await getDoc(userRef);
    if (cached.exists()) return cached;
    try {
      return await getDocFromServer(userRef);
    } catch {
      return cached;
    }
  }
  try {
    return await getDocFromServer(userRef);
  } catch {
    return await getDoc(userRef);
  }
}

async function readUsersByEmailVariant(variant, options = {}) {
  const forceServer = options.forceServer === true;
  const preferCacheFirst = !forceServer && options.preferCacheFirst !== false;
  const q = query(collection(db, "users"), where("email", "==", variant), limit(12));
  if (forceServer) {
    try {
      return await getDocsFromServer(q);
    } catch {
      return await getDocs(q);
    }
  }
  if (preferCacheFirst) {
    const cached = await getDocs(q);
    if (!cached.empty) return cached;
    try {
      return await getDocsFromServer(q);
    } catch {
      return cached;
    }
  }
  try {
    return await getDocsFromServer(q);
  } catch {
    return await getDocs(q);
  }
}

function emailQueryVariants(email = "") {
  const raw = String(email || "").trim();
  const lower = raw.toLowerCase();
  return [...new Set([raw, lower].filter(Boolean))];
}

/** 같은 이메일 users 문서가 여러 uid 로 있을 때 allowedEvents 를 합침 (직접 허용 uid 불일치 대응) */
export async function loadMergedAllowedEventsByEmail(email = "", primaryUid = "", options = {}) {
  const variants = emailQueryVariants(email);
  if (!variants.length && !primaryUid) return {};

  let merged = {};
  const seenUids = new Set();
  const readOpts = { preferCacheFirst: options.preferCacheFirst !== false };

  if (primaryUid) {
    try {
      const primarySnap = await readUserDocSnap(primaryUid, readOpts);
      if (primarySnap.exists()) {
        seenUids.add(primaryUid);
        merged = mergeAllowedEventsMaps(
          merged,
          opsAllowedEventsFromProfile(primarySnap.data() || {})
        );
      }
    } catch (err) {
      console.warn("[loadMergedAllowedEventsByEmail] primary uid read failed:", err);
    }
  }

  await Promise.all(
    variants.map(async (variant) => {
      try {
        const snap = await readUsersByEmailVariant(variant, readOpts);
        for (const d of snap.docs) {
          if (seenUids.has(d.id)) continue;
          seenUids.add(d.id);
          merged = mergeAllowedEventsMaps(merged, opsAllowedEventsFromProfile(d.data() || {}));
        }
      } catch (err) {
        console.warn("[loadMergedAllowedEventsByEmail] email query failed:", variant, err);
      }
    })
  );

  return merged;
}

function scheduleProfileServerRefresh(uid = "", email = "") {
  const id = String(uid || "").trim();
  if (!id) return;
  if (profileRefreshInflight.has(id)) return;
  const task = loadUserProfileFresh(id, email, {
    preferCacheFirst: false,
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
    if (loginCached && (!emailLc || !cachedEmailLc || emailLc === cachedEmailLc)) {
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

  const mergedAllowed = await loadMergedAllowedEventsByEmail(resolvedEmail, uid, {
    preferCacheFirst: options.preferCacheFirst !== false,
    forceServer: options.forceServer === true
  });
  if (!Object.keys(mergedAllowed).length) return profile;
  return normalizeUserProfile({ ...profile, allowedEvents: mergedAllowed }, resolvedEmail);
}

async function ensureFirestoreNetwork() {
  try {
    await enableNetwork(db);
  } catch {
    /* ignore */
  }
}

/** index·통합배치도 — 모바일 포함 서버·이메일 병합만 사용 (로컬 캐시 우회) */
export async function loadUserProfileForTournamentOps(uid, email = "", tournamentId = "", options = {}) {
  const tid = String(tournamentId || "").trim();
  const tournamentMeta = options.tournamentMeta || null;
  const serverOpts = { preferCacheFirst: false, skipLoginCache: true, forceServer: true };

  await ensureFirestoreNetwork();

  let profile = await loadUserProfileFresh(uid, email, serverOpts);
  profile = await enrichProfileWithEmailAllows(uid, email, profile, {
    preferCacheFirst: false,
    forceServer: true
  });

  if (!tid || !profile) return profile;
  if (canUseTournamentOps(email, profile, tid, tournamentMeta)) return profile;

  await ensureFirestoreNetwork();
  const fresh = await loadUserProfileFresh(uid, email, serverOpts);
  profile = await enrichProfileWithEmailAllows(uid, email, fresh || profile, {
    preferCacheFirst: false,
    forceServer: true
  });
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
