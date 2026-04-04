import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  initializeFirestore
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  getMessaging,
  isSupported
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyD6KXHIf1aaSDjbhHo8VtzbeMcaDIMP4SA",
  authDomain: "hanagency-c2c0e.firebaseapp.com",
  projectId: "hanagency-c2c0e",
  storageBucket: "hanagency-c2c0e.firebasestorage.app",
  messagingSenderId: "238155510408",
  appId: "1:238155510408:web:fbb571710c94d3fbb0e53d",
  measurementId: "G-N6FMJD2EHZ"
};

const app = initializeApp(firebaseConfig);

export { app };
export const auth = getAuth(app);

/*
  핵심 수정:
  - auto detect 대신 force long polling 사용
  - fetch streams 비활성
  - undefined 필드 무시
*/
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
  ignoreUndefinedProperties: true
});

console.log("[firebase] initialized", {
  origin: location.origin,
  hostname: location.hostname,
  projectId: firebaseConfig.projectId
});

export async function getMessagingSafe() {
  try {
    const supported = await isSupported();
    if (!supported) return null;
    return getMessaging(app);
  } catch (err) {
    console.error("getMessagingSafe error:", err);
    return null;
  }
}