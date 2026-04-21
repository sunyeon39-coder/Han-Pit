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

function mountAddToHomeHint() {
  if (shouldSkip()) return;

  const root = document.createElement("aside");
  root.className = "ath-hint";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Add to Home Screen guide");

  root.innerHTML = `
    <div class="ath-hint__header">
      <span class="ath-hint__title">홈 화면에 추가 · Add to Home Screen</span>
      <button type="button" class="ath-hint__close" aria-label="닫기 / Close">×</button>
    </div>
    <div class="ath-hint__body">
      <h3 class="ath-hint__sub">한국어</h3>
      <p><strong>Safari (iPhone·iPad)</strong> — 화면 아래 <strong>공유(□↑)</strong> 버튼을 누른 뒤, 아래로 스크롤하여 <strong>「홈 화면에 추가」</strong>를 선택하세요.</p>
      <p><strong>Chrome (Android)</strong> — 오른쪽 위 <strong>⋮ 메뉴</strong>를 누르고 <strong>「홈 화면에 추가」</strong> 또는 <strong>「앱 설치」</strong>를 선택하세요.</p>
      <p><strong>Chrome (iPhone)</strong> — iOS에서는 <strong>Safari</strong>로 여는 것을 권장합니다. Safari에서 위와 같이 공유 → 「홈 화면에 추가」를 선택하세요.</p>
      <div class="ath-hint__divider" aria-hidden="true"></div>
      <h3 class="ath-hint__sub">English</h3>
      <p><strong>Safari (iPhone·iPad)</strong> — Tap the <strong>Share (square with arrow)</strong> button, scroll down, then choose <strong>Add to Home Screen</strong>.</p>
      <p><strong>Chrome (Android)</strong> — Open the <strong>⋮ menu</strong> (top right) and choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</p>
      <p><strong>Chrome (iPhone)</strong> — On iOS, we recommend opening this site in <strong>Safari</strong>, then use <strong>Add to Home Screen</strong> as described above.</p>
    </div>
    <div class="ath-hint__footer">
      <button type="button" class="ath-hint__btn ath-hint__later" data-ath-later>닫기 (나중에) · Close (later)</button>
      <button type="button" class="ath-hint__btn ath-hint__btn--primary ath-hint__never" data-ath-never>다시 보지 않기 · Don’t show again</button>
    </div>
  `;

  const close = () => {
    try {
      sessionStorage.setItem(SS_SESSION, "1");
    } catch (_) {}
    removeHint(root);
  };

  const never = () => {
    try {
      localStorage.setItem(LS_NEVER, "never");
      sessionStorage.setItem(SS_SESSION, "1");
    } catch (_) {}
    removeHint(root);
  };

  root.querySelector(".ath-hint__close")?.addEventListener("click", close);
  root.querySelector("[data-ath-later]")?.addEventListener("click", close);
  root.querySelector("[data-ath-never]")?.addEventListener("click", never);

  document.body.appendChild(root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAddToHomeHint, { once: true });
} else {
  mountAddToHomeHint();
}
