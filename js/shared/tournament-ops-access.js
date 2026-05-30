import {
  canUseTournamentOps,
  hasDirectEventAllowFor,
  isSystemAdminEmail,
  normalizeUserProfile,
  opsAllowedEventsFromProfile,
  resolveStoredUserRole
} from "./auth-helpers.js";
import {
  readOpsSessionSnapshot,
  writeLoginProfileCache
} from "./login-profile-cache.js";

/**
 * 대회 운영 UI(통합 배치도·카드 관리·맵 편집 등) 표시 여부.
 * 시스템 admin 또는 해당 대회 직접 허용(allowedEvents) 만 인정 — 입장 코드만으로는 false.
 */
export function canShowTournamentOpsUi(
  email = "",
  profile = {},
  tournamentId = "",
  tournamentMeta = null,
  uid = ""
) {
  if (canUseTournamentOps(email, profile, tournamentId, tournamentMeta)) return true;

  const tid = String(tournamentId || "").trim();
  const id = String(uid || profile?.uid || "").trim();
  if (!tid || !id) return false;

  const snap = readOpsSessionSnapshot(id);
  if (!snap) return false;
  return hasDirectEventAllowFor(snap.allowedEvents, tid);
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
