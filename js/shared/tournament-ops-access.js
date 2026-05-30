import {
  canUseTournamentOps,
  hasAnyDirectEventAllow,
  hasDirectEventAllowForTournament,
  isSystemAdminEmail,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  resolveStoredUserRole,
  sanitizeAllowedEvents
} from "./auth-helpers.js";
import {
  readLoginProfileCache,
  readOpsSessionSnapshot,
  writeLoginProfileCache
} from "./login-profile-cache.js";

/** 직접 허용으로 role=admin (시스템 admin 제외) */
export function isDirectOpsAdmin(email = "", profile = {}) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isSystemAdminEmail(mail)) return false;
  const p = normalizeUserProfile(profile, mail);
  if (String(p.role || "").trim().toLowerCase() !== "admin") return false;
  return hasAnyDirectEventAllow(opsAllowedEventsFromProfile(p));
}

function directOpsAllowKeys(allowed = {}) {
  return Object.keys(sanitizeAllowedEvents(allowed)).filter((k) => allowed[k] === true);
}

function directOpsForTournament(email, profile, tournamentId, tournamentMeta, uid) {
  const tid = String(tournamentId || "").trim();
  if (!isDirectOpsAdmin(email, profile)) return false;

  const allowed = opsAllowedEventsFromProfile(normalizeUserProfile(profile, email));
  if (!tid) return directOpsAllowKeys(allowed).length > 0;

  if (hasDirectEventAllowForTournament(allowed, tid, tournamentMeta)) return true;

  const keys = directOpsAllowKeys(allowed);
  if (keys.length >= 1) return true;

  const id = String(uid || "").trim();
  if (!id) return false;

  const snap = readOpsSessionSnapshot(id);
  if (snap && hasDirectEventAllowForTournament(snap.allowedEvents, tid, tournamentMeta)) {
    return true;
  }
  if (snap && directOpsAllowKeys(snap.allowedEvents).length >= 1) return true;

  const cached = readLoginProfileCache(id);
  if (cached && isDirectOpsAdmin(email, cached)) {
    const cAllowed = opsAllowedEventsFromProfile(cached);
    if (hasDirectEventAllowForTournament(cAllowed, tid, tournamentMeta)) return true;
    if (directOpsAllowKeys(cAllowed).length >= 1) return true;
  }

  return false;
}

/**
 * 대회 운영 UI(통합 배치도·카드 관리·맵 편집 등) 표시 여부.
 * 시스템 admin 또는 직접 허용(admin+allowedEvents). 입장 코드만으로는 false.
 */
export function canShowTournamentOpsUi(
  email = "",
  profile = {},
  tournamentId = "",
  tournamentMeta = null,
  uid = ""
) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isSystemAdminEmail(mail)) return true;

  const p = normalizeUserProfile(profile, mail);
  if (canUseTournamentOps(mail, p, tournamentId, tournamentMeta)) return true;
  if (directOpsForTournament(mail, p, tournamentId, tournamentMeta, uid)) return true;

  return false;
}

/** Firestore users.role 과 동기화되는 운영 admin 여부(직접 허용·시스템 admin) */
export function resolveOpsAdminRole(email = "", profile = {}) {
  return resolveStoredUserRole(email, profile);
}

export function hasAnyTournamentOpsAllow(profile = {}) {
  const allowed = opsAllowedEventsFromProfile(profile);
  return Object.values(allowed).some((v) => v === true);
}

/** 직접 허용/해제 직후 로그인 캐시·허브/인덱스 부트 프로필 동기화 */
export function syncLoginCacheForOpsProfile(uid = "", profile = null) {
  const id = String(uid || "").trim();
  if (!id || !profile) return;
  writeLoginProfileCache(id, profile);
}

/** grant/revoke 후 메모리 프로필 — role·allowedEvents 를 규칙에 맞게 정규화 */
export function buildOpsProfilePatch(prev = {}, email = "", allowedEvents = {}) {
  const mail = String(email || prev.email || "").trim();
  const allowed = opsAllowedEventsFromProfile({ ...prev, allowedEvents });
  const opsTournamentIds = Object.keys(allowed).filter((k) => allowed[k] === true);
  return normalizeUserProfile(
    {
      ...prev,
      email: mail || prev.email || "",
      role: resolveOpsAdminRole(mail, { allowedEvents: allowed, opsTournamentIds }),
      allowedEvents: allowed,
      opsTournamentIds
    },
    mail
  );
}

export function isAccessManageAdmin(user, profile) {
  return isSystemAdminEmail(user?.email || profile?.email);
}
