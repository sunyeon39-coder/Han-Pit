export const ADMIN_EMAILS = [
  "sunyeon9501@gmail.com"
];

export function isAdminEmail(email = "") {
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

export const APP_TIME_ZONE = "Asia/Seoul"