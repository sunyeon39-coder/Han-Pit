import {
  canManageTournament,
  hasAnyDirectEventAllow,
  isAdminEmail,
  isSystemAdminEmail,
  resolveStoredUserRole,
  sanitizeAllowedEvents
} from "../shared/auth-helpers.js";

export { hasAnyDirectEventAllow };

/** 토너먼트 카드 / 유저 관리에서 동일 규칙으로 접근 가능 여부를 판별합니다. */
export function hasEventAccess(userProfile, tournament, authUser) {
  if (!userProfile || !tournament) return false;
  if (isAdminEmail(authUser?.email || userProfile.email || "")) return true;
  if (canManageTournament(authUser?.email || userProfile.email, userProfile, tournament.id)) {
    return true;
  }

  const allowedEvents = userProfile.allowedEvents || {};
  if (allowedEvents[tournament.id] === true) return true;

  const userCode = String(userProfile.accessCode || "").trim();
  const requiredCode = String(tournament.requiredCode || "").trim();

  if (userCode && requiredCode && userCode === requiredCode) return true;

  return false;
}

/** Hub Access Manage·유저 권한 — 시스템 admin 이메일만 */
export function getIsAdminUser(user, profile) {
  return isSystemAdminEmail(user?.email || profile?.email);
}

export function isValidDocId(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/");
}

export function normalizeTournamentDoc(d) {
  const data = d.data() || {};
  return {
    id: d.id,
    name: data.name || d.id,
    startDate: data.startDate || "",
    endDate: data.endDate || "",
    logoText: data.logoText || "HAN",
    requiredCode: data.requiredCode || ""
  };
}

export function normalizeUserDoc(d) {
  const data = d.data() || {};
  const email = String(data.email || "").trim();
  const allowedEvents = sanitizeAllowedEvents(data.allowedEvents);
  const role = resolveStoredUserRole(email, { ...data, allowedEvents });
  return {
    uid: d.id,
    nickname: data.nickname || "",
    email,
    role,
    accessCode: data.accessCode || "",
    allowedEvents,
    layoutAccentColor: data.layoutAccentColor || "",
    /** Firestore 원본 — 자동 보정용 */
    _rawRole: String(data.role || "").trim() || "user",
    _rawAllowedEvents: data.allowedEvents || {}
  };
}

export function sortTournaments(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export function routeToTournament(tournamentId) {
  if (!tournamentId) return;
  sessionStorage.setItem("tournamentId", tournamentId);
  try {
    const url = new URL("./index.html", location.href);
    url.searchParams.set("tournamentId", tournamentId);
    location.href = url.href;
  } catch {
    location.href = `./index.html?tournamentId=${encodeURIComponent(tournamentId)}`;
  }
}

/** 정렬용 표시명: 닉네임 우선, 없으면 이메일 */
export function getUserDisplayNameForSort(user) {
  const nick = String(user?.nickname || "").trim();
  if (nick) return nick;
  return String(user?.email || user?.uid || "").trim();
}

/**
 * 가입 유저 목록: 한글(가나다·ㄱ~ㅎ 계열) 먼저, 그다음 영문 A~Z, 그 외.
 */
export function getNameSortGroup(str) {
  const s = String(str || "").trim();
  if (!s) return 2;
  const cp = s.codePointAt(0);
  if (cp >= 0xac00 && cp <= 0xd7a3) return 0;
  if (cp >= 0x1100 && cp <= 0x11ff) return 0;
  if (cp >= 0x3130 && cp <= 0x318f) return 0;
  if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return 1;
  return 2;
}

export function compareUsersForAdminList(a, b) {
  const na = getUserDisplayNameForSort(a);
  const nb = getUserDisplayNameForSort(b);
  const ga = getNameSortGroup(na);
  const gb = getNameSortGroup(nb);
  if (ga !== gb) return ga - gb;
  if (ga === 0) return na.localeCompare(nb, "ko", { numeric: true });
  if (ga === 1) return na.localeCompare(nb, "en", { sensitivity: "base", numeric: true });
  return na.localeCompare(nb, "ko", { numeric: true });
}

export function sortUsersForAdminList(users) {
  return [...users].sort(compareUsersForAdminList);
}
