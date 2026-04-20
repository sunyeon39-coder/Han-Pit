import { isAdminEmail } from "../app_config.js";

export function getIsAdmin(user, profile) {
  return profile?.role === "admin" || isAdminEmail(user?.email || "");
}
