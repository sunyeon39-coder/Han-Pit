import { normalizeUserProfile, resolveStoredUserRole } from "./auth-helpers.js";

const LOGIN_PROFILE_CACHE_KEY = "hanpit_login_profile_cache_v1";

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
  try {
    sessionStorage.setItem(
      LOGIN_PROFILE_CACHE_KEY,
      JSON.stringify({
        uid: id,
        savedAt: Date.now(),
        profile: normalizeUserProfile(profile, profile.email || "")
      })
    );
  } catch {
    /* ignore */
  }
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
