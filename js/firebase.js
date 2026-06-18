import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  enableNetwork,
  initializeFirestore,
  memoryLocalCache
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
 * Safari/iOS 홈 화면 웹앱은 IndexedDB 영속 캐시 대신 memoryLocalCache 를 씁니다.
 * (페이지 이탈·백그라운드 시 hanging GET 이 끊길 때 콘솔 CORS 경고가 남을 수 있으나
 *  Firebase SDK 측 알려진 동작이며, 실제 쓰기/삭제 실패 시 아래 reconnect 로 복구)
 */
const firestoreSettings = {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false,
  useFetchStreams: false,
  experimentalLongPollingOptions: {
    timeoutSeconds: 30
  }
};

if (isSafariLikeBrowser() || isStandalonePwa()) {
  firestoreSettings.localCache = memoryLocalCache();
}

export const db = initializeFirestore(app, firestoreSettings);

export { app };
export const auth = getAuth(app);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void enableNetwork(db).catch(() => {});
  });
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) void enableNetwork(db).catch(() => {});
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
