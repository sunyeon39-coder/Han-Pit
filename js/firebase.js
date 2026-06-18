import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  enableNetwork,
  initializeFirestore
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging,
  isSupported
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

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

function isSafariLikeBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const ios =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return true;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
}

function isStandalonePwa() {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      window.navigator?.standalone === true
    );
  } catch {
    return false;
  }
}

/**
 * Safari·iOS PWA: WebChannel(Fetch Streams)이
 * "XMLHttpRequest … due to access control checks" 로 끊기는 문제 완화.
 * Listen·Write 채널 모두 long-polling + 비-stream 모드로 고정합니다.
 *
 * 영속 IndexedDB 캐시는 유지합니다. memoryLocalCache 는 모든 읽기를 batchGet 으로
 * 강제해 채널 불안정 시 unavailable 이 잦아져 사용하지 않습니다.
 * (페이지 이탈·백그라운드 시 hanging GET 이 끊길 때 콘솔 CORS 경고가 남을 수 있으나
 *  Firebase SDK 측 알려진 동작이며, 실제 읽기/쓰기 실패 시 reconnect·read retry 로 복구)
 */
const firestoreSettings = {};
if (isSafariLikeBrowser() || isStandalonePwa()) {
  Object.assign(firestoreSettings, {
    experimentalForceLongPolling: true,
    experimentalAutoDetectLongPolling: false,
    useFetchStreams: false,
    experimentalLongPollingOptions: {
      timeoutSeconds: 30
    }
  });
}

export const db = initializeFirestore(app, firestoreSettings);

export async function ensureFirestoreOnline() {
  try {
    await enableNetwork(db);
  } catch {
    // offline persistence may still serve cached reads
  }
}

export { app };
export const auth = getAuth(app);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void ensureFirestoreOnline();
  });
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) void ensureFirestoreOnline();
  });
}

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
