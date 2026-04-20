/**
 * Google OAuth 는 인앱 브라우저·WebView UA 에서 403 disallowed_useragent 로 차단됩니다.
 * https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html
 */

function ua() {
  return typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
}

/**
 * 인앱(WebView)에서 `location.href`가 `https//host/...` 처럼 깨지는 경우가 있어
 * 외부 브라우저로 넘길 때 반드시 정규화한다.
 */
export function normalizeAppPageHref(href) {
  let h = String(href || "").trim();
  if (!h) return h;
  h = h.replace(/^https\/\//i, "https://");
  h = h.replace(/^http\/\//i, "http://");
  h = h.replace(/^https:\/\/https:\/\//i, "https://");
  h = h.replace(/^https:\/\/https\/\//i, "https://");
  h = h.replace(/^https:\/\/https:/i, "https://");
  return h;
}

/** `googlechromes://` / `x-safari-https://` 에 넣을 `host + path + query + hash` */
export function iosExternalBrowserPathFromHref(href) {
  const raw = normalizeAppPageHref(href);
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch (_) {
    return "";
  }
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

const OAUTH_REDIRECT_PENDING_KEY = "hanpit:oauthRedirectPending";

export function markOAuthRedirectPending() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(OAUTH_REDIRECT_PENDING_KEY, "1");
    }
  } catch (_) {}
}

export function clearOAuthRedirectPending() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(OAUTH_REDIRECT_PENDING_KEY);
    }
  } catch (_) {}
}

export function isOAuthRedirectPending() {
  try {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(OAUTH_REDIRECT_PENDING_KEY) === "1";
  } catch (_) {
    return false;
  }
}

/**
 * GitHub Pages 등 앱 호스트와 authDomain(firebaseapp.com)이 다를 때,
 * Safari/Chrome(모바일 포함)은 리다이렉트 로그인용 서드파티 저장소가 막혀
 * 계정 선택 후에도 세션이 붙지 않는 경우가 많습니다.
 * @see https://firebase.google.com/docs/auth/web/redirect-best-practices
 *
 * 그래서 기본은 팝업 로그인을 쓰고, 팝업이 막힐 때만 리다이렉트로 폴백합니다.
 */
export function shouldPreferGoogleRedirectOverPopup() {
  return false;
}

/**
 * Android: Chrome 으로 현재 URL 열기 (intent).
 * Chrome 미설치 시 동작은 기기마다 다를 수 있음.
 */
export function openCurrentUrlInAndroidChrome() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  try {
    const href = normalizeAppPageHref(location.href);
    const u = new URL(href);
    const tail = `${u.host}${u.pathname}${u.search}${u.hash}`;
    const fallback = encodeURIComponent(href);
    window.location.href =
      `intent://${tail}#Intent;scheme=https;action=android.intent.action.VIEW;` +
      `category=android.intent.category.BROWSABLE;` +
      `package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
  } catch (_) {
    window.open(normalizeAppPageHref(location.href), "_blank", "noopener,noreferrer");
  }
}

/**
 * iOS: **시스템 Safari**로 현재 페이지 열기 (카카오·라인 등 인앱 → Safari).
 * `x-safari-https://호스트/경로…` 형식. Google 로그인도 Safari가 가장 안정적이다.
 */
export function openCurrentUrlInIosSystemSafari() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  const href = normalizeAppPageHref(location.href);
  const tail = iosExternalBrowserPathFromHref(href);
  if (!tail) {
    window.location.href = href;
    return;
  }
  try {
    const u = new URL(href);
    const scheme = u.protocol === "https:" ? "x-safari-https" : "x-safari-http";
    window.location.href = `${scheme}://${tail}`;
  } catch (_) {
    window.location.href = href;
  }
}

/**
 * iOS: **Chrome 앱**으로 같은 URL 열기.
 * 잘못된 `googlechromes://https://…` 는 호스트가 `https` 로 해석되어 ERR_NAME_NOT_RESOLVED 가 난다.
 * 반드시 `googlechromes://호스트/경로…` 만 전달한다.
 * @see https://developer.chrome.com/docs/ios/links/
 */
export function openCurrentUrlInIosChrome() {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  const href = normalizeAppPageHref(location.href);
  const tail = iosExternalBrowserPathFromHref(href);
  if (!tail) {
    window.location.href = href;
    return;
  }
  try {
    const u = new URL(href);
    if (u.protocol === "https:") {
      window.location.href = `googlechromes://${tail}`;
      return;
    }
    if (u.protocol === "http:") {
      window.location.href = `googlechrome://${tail}`;
      return;
    }
  } catch (_) {}
  window.location.href = href;
}

export async function copyCurrentUrlToClipboard() {
  const href =
    typeof location !== "undefined" ? normalizeAppPageHref(location.href) : "";
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
