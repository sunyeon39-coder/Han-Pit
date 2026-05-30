import {
  mergeAllowedEventsMaps,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  resolveStoredUserRole,
  sanitizeAllowedEvents
} from "./auth-helpers.js";

const LOGIN_PROFILE_CACHE_KEY = "hanpit_login_profile_cache_v1";
const OPS_SESSION_KEY = "hanpit_ops_session_v1";
const OPS_SESSION_MAX_AGE_MS = 86400000;

export function buildOptimisticProfileFromAuthUser(user, prev = {}) {
  const email = String(user?.email || prev.email || "").trim();
  return normalizeUserProfile(
    {
      email,
      nickname: String(prev.nickname || user?.displayName || "").trim(),
      phone: String(prev.phone || "").trim(),
      gender: String(prev.gender || "none").trim() || "none",
      photoURL: String(prev.photoURL || user?.photoURL || "").trim(),
      role: resolveStoredUserRole(email, prev),
      accessCode: String(prev.accessCode || "").trim(),
      allowedEvents: prev.allowedEvents && typeof prev.allowedEvents === "object" ? prev.allowedEvents : {}
    },
    email
  );
}

export function readOpsSessionSnapshot(uid = "") {
  const id = String(uid || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(OPS_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (String(o?.uid || "").trim() !== id) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > OPS_SESSION_MAX_AGE_MS) return null;
    return {
      allowedEvents: sanitizeAllowedEvents(o.allowedEvents || {}),
      savedAt: Number(o.savedAt || 0)
    };
  } catch {
    return null;
  }
}

/** 허브→index 직후 모바일에서 운영 UI 가 즉시 켜지도록 allowedEvents 스냅샷 저장 */
export function writeOpsSessionSnapshot(uid = "", profile = null) {
  const id = String(uid || "").trim();
  if (!id || !profile) return;
  const allowed = opsAllowedEventsFromProfile(profile);
  if (!Object.keys(allowed).length) {
    try {
      sessionStorage.removeItem(OPS_SESSION_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    sessionStorage.setItem(
      OPS_SESSION_KEY,
      JSON.stringify({
        uid: id,
        savedAt: Date.now(),
        allowedEvents: allowed
      })
    );
  } catch {
    /* ignore */
  }
}

export function clearOpsSessionSnapshot() {
  try {
    sessionStorage.removeItem(OPS_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** 앱 부트 시 — session 캐시 + 직접 허용 스냅샷 병합 */
export function readBootUserProfile(user, prev = {}) {
  const uid = String(user?.uid || "").trim();
  const cached = uid ? readLoginProfileCache(uid) : null;
  const opsSnap = uid ? readOpsSessionSnapshot(uid) : null;
  const email = String(user?.email || cached?.email || prev.email || "").trim();
  const mergedAllowed = mergeAllowedEventsMaps(
    cached?.allowedEvents && typeof cached.allowedEvents === "object" ? cached.allowedEvents : {},
    opsSnap?.allowedEvents || {},
    prev.allowedEvents && typeof prev.allowedEvents === "object" ? prev.allowedEvents : {}
  );
  return normalizeUserProfile(
    {
      ...(cached || prev),
      email: email || cached?.email || "",
      opsTournamentIds:
        cached?.opsTournamentIds ?? prev.opsTournamentIds ?? [],
      allowedEvents: mergedAllowed
    },
    email
  );
}

export function readLoginProfileCache(uid = "") {
  const id = String(uid || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(LOGIN_PROFILE_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (String(o?.uid || "").trim() !== id) return null;
    const profile = o.profile;
    if (!profile || typeof profile !== "object") return null;
    return normalizeUserProfile(profile, profile.email || "");
  } catch {
    return null;
  }
}

export function writeLoginProfileCache(uid = "", profile = null) {
  const id = String(uid || "").trim();
  if (!id || !profile) return;
  const normalized = normalizeUserProfile(profile, profile.email || "");
  try {
    sessionStorage.setItem(
      LOGIN_PROFILE_CACHE_KEY,
      JSON.stringify({
        uid: id,
        savedAt: Date.now(),
        profile: normalized
      })
    );
  } catch {
    /* ignore */
  }
  writeOpsSessionSnapshot(id, normalized);
}

export function clearLoginProfileCache() {
  try {
    sessionStorage.removeItem(LOGIN_PROFILE_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** 허브 부트 직후 Firestore 서버 읽기 전에 잠깐 쓸 수 있는 캐시인지 */
export function isLoginProfileCacheFresh(uid = "", maxAgeMs = 120000) {
  const id = String(uid || "").trim();
  if (!id) return false;
  try {
    const raw = sessionStorage.getItem(LOGIN_PROFILE_CACHE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (String(o?.uid || "").trim() !== id) return false;
    const age = Date.now() - Number(o.savedAt || 0);
    return age >= 0 && age <= maxAgeMs;
  } catch {
    return false;
  }
}
