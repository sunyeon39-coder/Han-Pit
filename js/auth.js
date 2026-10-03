import { auth } from "./firebase.js";
import {
  signInWithPopup,
  signInWithRedirect,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { createGoogleAuthProvider } from "./shared/google-auth-provider.js";
import {
  isGoogleOAuthLikelyBlockedBrowser,
  shouldPreferGoogleRedirectOverPopup,
  markOAuthRedirectPending,
  clearOAuthRedirectPending
} from "./shared/google-oauth-environment.js";

export async function loginWithGoogle() {
  if (isGoogleOAuthLikelyBlockedBrowser()) {
    throw new Error(
      "IN_APP_BROWSER: Google 로그인은 Chrome 또는 Safari 등 일반 브라우저에서만 사용할 수 있습니다."
    );
  }

  // 팝업 전에 await signOut 하면 iPhone Safari·PWA에서 "사용자가 누른 직후" 조건이 깨져
  // 팝업이 차단되고, 다른 도메인(firebaseapp.com) 리다이렉트로 넘어가 계정을 골라도
  // 로그인이 안 붙는 원인이 됐다. signInWithPopup 은 기존 로그인 사용자를 알아서 교체한다.

  const provider = createGoogleAuthProvider();

  if (shouldPreferGoogleRedirectOverPopup()) {
    markOAuthRedirectPending();
    await signInWithRedirect(auth, provider);
    return null;
  }

  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error("loginWithGoogle popup error:", error);

    const fallbackCodes = [
      "auth/popup-blocked",
      "auth/popup-closed-by-user",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment"
    ];

    if (fallbackCodes.includes(error?.code)) {
      markOAuthRedirectPending();
      await signInWithRedirect(auth, provider);
      return null;
    }

    throw error;
  }
}

export function requireAuth(onAuthed) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      location.replace("./login.html");
    } else {
      onAuthed(user);
    }
  });
}

export async function logout() {
  clearOAuthRedirectPending();
  await signOut(auth);
  location.replace("./login.html");
}
