import { isAdminEmail } from "../app_config.js";

export { isAdminEmail };

export function isSystemAdminEmail(email = "") {
  return isAdminEmail(
    String(email || "")
      .trim()
      .toLowerCase()
  );
}

export function sanitizeAllowedEvents(allowedEvents = {}) {
  const out = {};
  for (const [key, value] of Object.entries(allowedEvents || {})) {
    const id = String(key || "").trim();
    if (!id) continue;
    if (value === true || value === "true" || value === 1) out[id] = true;
  }
  return out;
}

export function mergeAllowedEventsMaps(...maps) {
  return sanitizeAllowedEvents(Object.assign({}, ...maps));
}

/** allowedEvents 맵 + opsTournamentIds 배열을 하나의 맵으로 */
export function opsAllowedEventsFromProfile(profile = {}) {
  const fromMap = sanitizeAllowedEvents(profile?.allowedEvents);
  const ids = Array.isArray(profile?.opsTournamentIds) ? profile.opsTournamentIds : [];
  const fromList = {};
  for (const id of ids) {
    const key = String(id || "").trim();
    if (key) fromList[key] = true;
  }
  return mergeAllowedEventsMaps(fromMap, fromList);
}

export function hasAnyDirectEventAllow(allowedEvents = {}) {
  return Object.values(sanitizeAllowedEvents(allowedEvents)).some((v) => v === true);
}

/** Firestore users.allowedEvents 기준 직접 허용 (opsTournamentIds 단독은 인정하지 않음) */
export function hasPersistedDirectOpsAllow(profile = {}) {
  return hasAnyDirectEventAllow(sanitizeAllowedEvents(profile?.allowedEvents));
}

/** 직접 허용 유저 Firestore 동기화용 — role·allowedEvents·opsTournamentIds */
export function buildDirectOpsPersistPatch(profile = {}, email = "") {
  const normalized = normalizeUserProfile(profile, email || profile?.email || "");
  const allowed = opsAllowedEventsFromProfile(normalized);
  if (!hasAnyDirectEventAllow(allowed)) return null;

  const ids = Array.isArray(profile?.opsTournamentIds)
    ? profile.opsTournamentIds.map((id) => String(id || "").trim()).filter(Boolean)
    : Object.keys(allowed);

  return {
    role: "admin",
    allowedEvents: allowed,
    opsTournamentIds: [...new Set(ids)]
  };
}

export function hasDirectEventAllowFor(allowedEvents = {}, eventId = "") {
  const sanitized = sanitizeAllowedEvents(allowedEvents);
  const id = String(eventId || "").trim();
  if (!id) return hasAnyDirectEventAllow(sanitized);
  if (sanitized[id] === true) return true;
  const lower = id.toLowerCase();
  return Object.entries(sanitized).some(
    ([key, value]) => value === true && String(key || "").trim().toLowerCase() === lower
  );
}

/** 직접 허용 변경 후 Firestore role — 시스템 admin / 허용 있음 → admin, 없음 → user */
export function resolveDirectOpsRole(email = "", allowedEvents = {}) {
  if (isSystemAdminEmail(email)) return "admin";
  if (hasAnyDirectEventAllow(allowedEvents)) return "admin";
  return "user";
}

/** Firestore users 문서 role — 시스템 admin 또는 직접 허용(admin) */
export function resolveStoredUserRole(email = "", profile = {}) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isAdminEmail(mail)) return "admin";
  if (hasAnyDirectEventAllow(opsAllowedEventsFromProfile(profile))) return "admin";
  return "user";
}

export function isOpsAdminProfile(profile = {}, email = "") {
  if (!profile || typeof profile !== "object") return false;
  if (isSystemAdminEmail(email || profile?.email)) return true;
  return hasAnyDirectEventAllow(opsAllowedEventsFromProfile(profile));
}

/** 대회별 배치·통합배치도 운영 권한 */
export function canManageTournament(email = "", profile = {}, tournamentId = "") {
  return canUseTournamentOps(email, profile, tournamentId);
}

export function normalizeUserProfile(profile = {}, email = "") {
  const next = { ...profile };
  next.allowedEvents = opsAllowedEventsFromProfile(next);
  next.role = resolveStoredUserRole(email || profile?.email, next);
  return next;
}

/** PWA·오프라인 캐시 스냅샷이 allowedEvents 를 비우는 것을 막음 */
export function mergeOpsProfile(prev = null, next = null, meta = {}) {
  if (!next || typeof next !== "object") return prev || null;
  const normalized = normalizeUserProfile(next, next.email || prev?.email || "");
  if (!meta.fromCache || !prev) return normalized;

  const prevAllowed = opsAllowedEventsFromProfile(prev);
  const nextAllowed = opsAllowedEventsFromProfile(normalized);
  const mergedAllowed = mergeAllowedEventsMaps(prevAllowed, nextAllowed);
  const prevRole = String(prev.role || "").trim().toLowerCase();
  const nextRole = String(normalized.role || "").trim().toLowerCase();
  let patched = normalized;

  if (Object.keys(prevAllowed).length > 0 && Object.keys(nextAllowed).length === 0) {
    patched = normalizeUserProfile(
      { ...normalized, allowedEvents: mergedAllowed },
      normalized.email || prev.email || ""
    );
  } else if (Object.keys(mergedAllowed).length > Object.keys(nextAllowed).length) {
    patched = normalizeUserProfile(
      { ...normalized, allowedEvents: mergedAllowed },
      normalized.email || prev.email || ""
    );
  }

  const prevHadOps = hasPersistedDirectOpsAllow(prev);
  const mergedHadOps = hasAnyDirectEventAllow(mergedAllowed);

  if ((prevRole === "admin" || prevHadOps || mergedHadOps) && nextRole !== "admin") {
    patched = normalizeUserProfile(
      {
        ...patched,
        role: "admin",
        allowedEvents: mergedAllowed
      },
      normalized.email || prev?.email || ""
    );
  }

  return patched;
}

/** layout / global-layout / index 공통 — 해당 대회 운영(배치·통합배치도·블락 등) 권한 */
export function canManageTournamentOps(email = "", profile = {}, tournamentId = "") {
  return canUseTournamentOps(email, profile, tournamentId);
}

/** index·layout 운영 UI — 시스템 admin 또는 직접 허용(role admin) */
export function canUseTournamentOps(email = "", profile = {}, tournamentId = "") {
  if (!profile || typeof profile !== "object") profile = {};
  if (isSystemAdminEmail(email || profile?.email)) return true;
  return hasDirectEventAllowFor(opsAllowedEventsFromProfile(profile), tournamentId);
}

export function getIsAdmin(user, profile) {
  if (!profile && !user) return false;
  return resolveStoredUserRole(user?.email || profile?.email, profile || {}) === "admin";
}
