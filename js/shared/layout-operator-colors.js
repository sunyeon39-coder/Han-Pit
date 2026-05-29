import { isAdminEmail } from "../app_config.js";

/** 통합 배치도 — 운영자(직접 허용) 구분용 팔레트 */
export const LAYOUT_OPERATOR_COLORS = [
  "#4DA3FF",
  "#FF6B6B",
  "#51CF66",
  "#F59F00",
  "#B197FC",
  "#20C997",
  "#FF8787",
  "#74C0FC",
  "#63E6BE",
  "#FFA94D"
];

/** 최고 관리자(고정 이메일) — 항상 동일 색 */
export const LAYOUT_OWNER_COLOR = "#E8C66A";

export function isValidLayoutAccentColor(value = "") {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || "").trim());
}

export function colorForUidFallback(uid = "") {
  const s = String(uid || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return LAYOUT_OPERATOR_COLORS[h % LAYOUT_OPERATOR_COLORS.length];
}

export function resolveLayoutAccentColor(profile = {}, uid = "", email = "") {
  const mail = String(email || profile?.email || "").trim();
  if (isAdminEmail(mail)) return LAYOUT_OWNER_COLOR;

  const stored = String(profile?.layoutAccentColor || "").trim();
  if (isValidLayoutAccentColor(stored)) return stored;

  return colorForUidFallback(uid);
}

/** Hub 유저 목록 기준 — 아직 안 쓰인 색 우선 */
export function pickUnusedLayoutAccentColor(users = [], uid = "") {
  const used = new Set();
  for (const u of users || []) {
    const c = String(u?.layoutAccentColor || "").trim();
    if (isValidLayoutAccentColor(c)) used.add(c.toUpperCase());
  }
  used.add(LAYOUT_OWNER_COLOR.toUpperCase());

  for (const c of LAYOUT_OPERATOR_COLORS) {
    if (!used.has(c.toUpperCase())) return c;
  }
  return colorForUidFallback(uid);
}
