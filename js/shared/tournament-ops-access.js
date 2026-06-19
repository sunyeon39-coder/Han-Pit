import {
  canUseTournamentOps,
  hasDirectEventAllowForTournament,
  hasPersistedDirectOpsAllow,
  isSystemAdminEmail,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  resolveStoredUserRole,
  sanitizeAllowedEvents
} from "./auth-helpers.js";
import { writeLoginProfileCache } from "./login-profile-cache.js";

/** 직접 허용으로 role=admin (시스템 admin 제외) */
export function isDirectOpsAdmin(email = "", profile = {}) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isSystemAdminEmail(mail)) return false;
  const p = normalizeUserProfile(profile, mail);
  if (String(p.role || "").trim().toLowerCase() !== "admin") return false;
  return hasPersistedDirectOpsAllow(p);
}

/**
 * 대회 운영 UI(통합 배치도·카드 관리·맵 편집 등) 표시 여부.
 * 시스템 admin 또는 Firestore allowedEvents 직접 허용. 입장 코드만으로는 false.
 */
export function canShowTournamentOpsUi(
  email = "",
  profile = {},
  tournamentId = "",
  tournamentMeta = null,
  _uid = ""
) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isSystemAdminEmail(mail)) return true;

  const p = normalizeUserProfile(profile, mail);
  return canUseTournamentOps(mail, p, tournamentId, tournamentMeta);
}

/** Firestore users.role 과 동기화되는 운영 admin 여부(직접 허용·시스템 admin) */
export function resolveOpsAdminRole(email = "", profile = {}) {
  return resolveStoredUserRole(email, profile);
}

export function hasAnyTournamentOpsAllow(profile = {}) {
  return hasPersistedDirectOpsAllow(profile);
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
  const opsTournamentIds = Object.keys(sanitizeAllowedEvents(allowed)).filter((k) => allowed[k] === true);
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
