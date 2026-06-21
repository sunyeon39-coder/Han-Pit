import { isAdminEmail } from "../app_config.js";
import {
  hasAnyDirectEventAllow,
  hasPersistedDirectOpsAllow,
  mergeAllowedEventsMaps,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  resolveStoredUserRole,
  sanitizeAllowedEvents
} from "./auth-helpers.js";

const LOGIN_PROFILE_CACHE_KEY = "hanpit_login_profile_cache_v1";
const LOGIN_PROFILE_LOCAL_KEY = "hanpit_login_profile_local_v1";
const OPS_SESSION_KEY = "hanpit_ops_session_v1";
const OPS_LOCAL_KEY = "hanpit_ops_local_v1";
const OPS_SESSION_MAX_AGE_MS = 86400000;

function readJsonStore(store, key) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJsonStore(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeFromStores(key) {
  try {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

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

  for (const store of [localStorage, sessionStorage]) {
    for (const key of [OPS_LOCAL_KEY, OPS_SESSION_KEY]) {
      const o = readJsonStore(store, key);
      if (!o || String(o?.uid || "").trim() !== id) continue;
      const age = Date.now() - Number(o.savedAt || 0);
      if (age < 0 || age > OPS_SESSION_MAX_AGE_MS) continue;
      return {
        allowedEvents: sanitizeAllowedEvents(o.allowedEvents || {}),
        savedAt: Number(o.savedAt || 0)
      };
    }
  }
  return null;
}

/** 허브→index·모바일(PWA) — allowedEvents 를 localStorage+session 에 저장 */
export function writeOpsSessionSnapshot(uid = "", profile = null) {
  const id = String(uid || "").trim();
  if (!id || !profile) return;
  const allowed = sanitizeAllowedEvents(profile?.allowedEvents);
  if (!hasAnyDirectEventAllow(allowed)) {
    clearOpsSessionSnapshot();
    return;
  }
  const payload = {
    uid: id,
    savedAt: Date.now(),
    allowedEvents: allowed
  };
  writeJsonStore(localStorage, OPS_LOCAL_KEY, payload);
  writeJsonStore(sessionStorage, OPS_SESSION_KEY, payload);
}

export function clearOpsSessionSnapshot() {
  removeFromStores(OPS_SESSION_KEY);
  removeFromStores(OPS_LOCAL_KEY);
}

/** 앱 부트 — 표시용 닉네임 등만 캐시, 운영 권한(allowedEvents)은 서버 확인 전 사용하지 않음 */
export function readBootUserProfile(user, prev = {}) {
  const uid = String(user?.uid || "").trim();
  const cached = uid ? readLoginProfileCache(uid) : null;
  const email = String(user?.email || cached?.email || prev.email || "").trim();
  const base = cached || prev;
  const profile = normalizeUserProfile(
    {
      email: email || cached?.email || "",
      nickname: String(base?.nickname || user?.displayName || "").trim(),
      phone: String(base?.phone || "").trim(),
      gender: String(base?.gender || "none").trim() || "none",
      photoURL: String(base?.photoURL || user?.photoURL || "").trim(),
      accessCode: String(base?.accessCode || "").trim(),
      allowedEvents: {},
      role: "user"
    },
    email
  );
  if (isAdminEmail(email)) {
    return normalizeUserProfile(
      {
        ...profile,
        allowedEvents: sanitizeAllowedEvents(base?.allowedEvents),
        role: resolveStoredUserRole(email, base || {})
      },
      email
    );
  }
  return profile;
}

export function readLoginProfileCache(uid = "") {
  const id = String(uid || "").trim();
  if (!id) return null;

  for (const store of [localStorage, sessionStorage]) {
    for (const key of [LOGIN_PROFILE_LOCAL_KEY, LOGIN_PROFILE_CACHE_KEY]) {
      const o = readJsonStore(store, key);
      if (!o || String(o?.uid || "").trim() !== id) continue;
      const profile = o.profile;
      if (!profile || typeof profile !== "object") continue;
      return normalizeUserProfile(profile, profile.email || "");
    }
  }
  return null;
}

export function writeLoginProfileCache(uid = "", profile = null) {
  const id = String(uid || "").trim();
  if (!id || !profile) return;
  let normalized = normalizeUserProfile(profile, profile.email || "");
  const mail = String(normalized.email || "").trim();
  if (!isAdminEmail(mail) && !hasPersistedDirectOpsAllow(normalized)) {
    normalized = normalizeUserProfile(
      {
        ...normalized,
        role: "user",
        allowedEvents: {},
        opsTournamentIds: []
      },
      mail
    );
  }
  const payload = {
    uid: id,
    savedAt: Date.now(),
    profile: normalized
  };
  writeJsonStore(localStorage, LOGIN_PROFILE_LOCAL_KEY, payload);
  writeJsonStore(sessionStorage, LOGIN_PROFILE_CACHE_KEY, payload);
  writeOpsSessionSnapshot(id, normalized);
}

export function clearLoginProfileCache() {
  removeFromStores(LOGIN_PROFILE_CACHE_KEY);
  removeFromStores(LOGIN_PROFILE_LOCAL_KEY);
  clearOpsSessionSnapshot();
}

/** 허브 부트 직후 Firestore 서버 읽기 전에 잠깐 쓸 수 있는 캐시인지 */
export function isLoginProfileCacheFresh(uid = "", maxAgeMs = 120000) {
  const id = String(uid || "").trim();
  if (!id) return false;

  for (const store of [localStorage, sessionStorage]) {
    for (const key of [LOGIN_PROFILE_LOCAL_KEY, LOGIN_PROFILE_CACHE_KEY]) {
      const o = readJsonStore(store, key);
      if (!o || String(o?.uid || "").trim() !== id) continue;
      const age = Date.now() - Number(o.savedAt || 0);
      if (age >= 0 && age <= maxAgeMs) return true;
    }
  }
  return false;
}
