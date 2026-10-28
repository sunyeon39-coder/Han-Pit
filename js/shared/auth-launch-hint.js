/**
 * PWA 재실행 시 로그인 화면을 건너뛰기 위한 힌트 — "이 기기에 로그인된 계정이 있었다".
 * 실제 인증은 각 페이지의 onAuthStateChanged 가 확인하고, 로그아웃 상태면 힌트를 지운 뒤
 * login.html 로 보내므로 login ↔ hub 무한 이동이 생기지 않는다.
 * login.html 의 인라인 스크립트가 같은 키를 읽는다.
 */
const AUTH_LAUNCH_HINT_KEY = "hanpit_auth_launch_hint_v1";

export function setAuthLaunchHint(uid = "") {
  const id = String(uid || "").trim();
  if (!id) return;
  try {
    localStorage.setItem(AUTH_LAUNCH_HINT_KEY, id);
  } catch {
    /* ignore */
  }
}

export function clearAuthLaunchHint() {
  try {
    localStorage.removeItem(AUTH_LAUNCH_HINT_KEY);
  } catch {
    /* ignore */
  }
}
