import { auth } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

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
  await signOut(auth);
  location.replace("./login.html");
}
