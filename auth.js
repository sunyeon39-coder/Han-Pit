// js/auth.js
import { auth } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/* ===============================
   LOGIN
=============================== */
export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const result = await signInWithPopup(auth, provider);
  return result.user;
}

/* ===============================
   AUTH GUARD
=============================== */
export function requireAuth(onAuthed) {
  onAuthStateChanged(auth, user => {
    if (!user) {
      location.replace("login.html");
    } else {
      onAuthed(user);
    }
  });
}

/* ===============================
   LOGOUT
=============================== */
export async function logout() {
  await signOut(auth);
  location.replace("login.html");
}
