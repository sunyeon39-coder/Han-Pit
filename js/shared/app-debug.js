/**
 * 개발용 진단 로그 게이트 (기본 비활성).
 * - URL: ?debug=1 또는 ?appDebug=1
 * - localStorage: appDebug === "1" | "true"
 */
export function isAppDebugEnabled() {
  try {
    if (typeof location !== "undefined" && location.search) {
      const p = new URLSearchParams(location.search);
      if (p.get("debug") === "1" || p.get("appDebug") === "1") return true;
    }
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem("appDebug");
      if (v === "1" || v === "true") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * layout heal 전용 추가: ?layoutDebug=1 또는 localStorage layoutDebugHeal
 * (앱 전체 debug=1 이면 heal 로그도 켜짐)
 */
export function isLayoutHealDebugEnabled() {
  if (isAppDebugEnabled()) return true;
  try {
    if (typeof location !== "undefined" && location.search) {
      const p = new URLSearchParams(location.search);
      if (p.get("layoutDebug") === "1") return true;
    }
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem("layoutDebugHeal");
      if (v === "1" || v === "true") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
