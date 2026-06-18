import { GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

/** 로그아웃 후에도 Google 세션이 남아 있어도 계정 선택 화면을 띄웁니다. */
export function createGoogleAuthProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}
