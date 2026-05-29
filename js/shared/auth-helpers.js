import { isAdminEmail } from "../app_config.js";

export function hasAnyDirectEventAllow(allowedEvents = {}) {
  return Object.values(allowedEvents || {}).some((v) => v === true);
}

/** Firestore users 문서에 저장할 role (직접 허용 = admin) */
export function resolveStoredUserRole(email = "", profile = {}) {
  const mail = String(email || profile?.email || "")
    .trim()
    .toLowerCase();
  if (isAdminEmail(mail)) return "admin";
  if (String(profile?.role || "").trim() === "admin") return "admin";
  if (hasAnyDirectEventAllow(profile?.allowedEvents)) return "admin";
  return "user";
}

export function normalizeUserProfile(profile = {}, email = "") {
  const next = { ...profile };
  next.role = resolveStoredUserRole(email || profile?.email, profile);
  return next;
}

export function getIsAdmin(user, profile) {
  if (!profile && !user) return false;
  return resolveStoredUserRole(user?.email || profile?.email, profile || {}) === "admin";
}
