/**
 * Safari / Chrome 등에서 홈 화면(바로가기) 추가 방법 안내 — 한국어 + English
 * 이미 standalone PWA 로 열려 있거나 사용자가 숨긴 경우에는 표시하지 않습니다.
 */

const LS_NEVER = "hanpit:addToHomeHint:v1";
const SS_SESSION = "hanpit:addToHomeHint:v1:session";

function isStandaloneDisplay() {
  if (typeof window === "undefined") return true;
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
    if (window.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  } catch (_) {}
  return typeof navigator !== "undefined" && navigator.standalone === true;
}

function shouldSkip() {
  if (isStandaloneDisplay()) return true;
  try {
    if (localStorage.getItem(LS_NEVER) === "never") return true;
    if (sessionStorage.getItem(SS_SESSION) === "1") return true;
  } catch (_) {}
  return false;
}

function removeHint(el) {
  el?.remove();
}

function mountAddToHomeHint() {}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAddToHomeHint, { once: true });
} else {
  mountAddToHomeHint();
}
