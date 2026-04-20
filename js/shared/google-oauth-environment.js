/**
 * Google OAuth 는 인앱 브라우저·WebView UA 에서 403 disallowed_useragent 로 차단됩니다.
 * https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html
 */

function ua() {
  return typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
}

export function isStandalonePwaDisplay() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
    if (window.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  } catch (_) {}
  return typeof navigator !== "undefined" && navigator.standalone === true;
}

/**
 * 구글 로그인이 막히는 환경(카카오·라인·페북 인앱, Android System WebView 등).
 * 단, 홈 화면에 추가한 단독 PWA 는 예외(일반 브라우저 엔진).
 */
export function isGoogleOAuthLikelyBlockedBrowser() {
  if (typeof navigator === "undefined") return false;
  if (isStandalonePwaDisplay()) return false;

  const s = ua();
  if (!s) return false;

  if (/; wv\)/i.test(s)) return true;
  if (/KAKAOTALK|KakaoTalk/i.test(s)) return true;
  if (/Line\//i.test(s)) return true;
  if (/Instagram/i.test(s)) return true;
  if (/FBAN|FBAV|FB_IAB/i.test(s)) return true;
  if (/MicroMessenger/i.test(s)) return true;
  if (/NAVER\(|NAVER\/|DaumApps/i.test(s)) return true;
  if (/Snapchat/i.test(s)) return true;

  return false;
}

/** 일반 모바일 브라우저에서는 popup 보다 redirect 가 안정적인 경우가 많음 */
export function shouldPreferGoogleRedirectOverPopup() {
  if (typeof navigator === "undefined") return false;
  if (isGoogleOAuthLikelyBlockedBrowser()) return false;
  const s = ua();
  if (/Android/i.test(s)) return true;
  if (/iPhone|iPad|iPod/i.test(s)) return true;
  return false;
}

/**
 * Android: Chrome 으로 현재 URL 열기 (intent).
 * Chrome 미설치 시 동작은 기기마다 다를 수 있음.
 */
export function openCurrentUrlInAndroidChrome() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  try {
    const u = new URL(location.href);
    const tail = `${u.host}${u.pathname}${u.search}${u.hash}`;
    const fallback = encodeURIComponent(location.href);
    window.location.href =
      `intent://${tail}#Intent;scheme=https;action=android.intent.action.VIEW;` +
      `category=android.intent.category.BROWSABLE;` +
      `package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
  } catch (_) {
    window.open(location.href, "_blank", "noopener,noreferrer");
  }
}

export function openCurrentUrlInSamsungInternet() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  try {
    const u = new URL(location.href);
    const tail = `${u.host}${u.pathname}${u.search}${u.hash}`;
    const fallback = encodeURIComponent(location.href);
    window.location.href =
      `intent://${tail}#Intent;scheme=https;action=android.intent.action.VIEW;` +
      `category=android.intent.category.BROWSABLE;` +
      `package=com.sec.android.app.sbrowser;S.browser_fallback_url=${fallback};end`;
  } catch (_) {
    window.open(location.href, "_blank", "noopener,noreferrer");
  }
}

/** iOS: 설치된 Chrome 앱으로 열기 시도 (미설치 시 아무 일 없을 수 있음) */
export function openCurrentUrlInIosChrome() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  const href = location.href;
  window.location.href = `googlechrome://navigate?url=${encodeURIComponent(href)}`;
}

export async function copyCurrentUrlToClipboard() {
  const href = typeof location !== "undefined" ? location.href : "";
  if (!href) return false;
  try {
    if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(href);
      return true;
    }
  } catch (_) {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = href;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
