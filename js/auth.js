import { auth } from "./firebase.js";
import {
  signInWithPopup,
  signInWithRedirect,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
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

  if (auth.currentUser) {
    try {
      await signOut(auth);
    } catch (signOutErr) {
      console.warn("loginWithGoogle pre-signOut:", signOutErr);
    }
  }

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
