/** Firebase onAuthStateChanged 는 토큰 갱신마다 재호출됨 — 동일 uid 재부트 방지 */
export function isSameAuthSession(prevUid = "", user = null) {
  const next = String(user?.uid || "").trim();
  if (!next) return false;
  return String(prevUid || "").trim() === next;
}
