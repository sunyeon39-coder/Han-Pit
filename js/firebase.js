import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getMessaging,
  isSupported
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";

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

export function isSafariLikeFirestoreClient() {
  return isSafariLikeBrowser() || isStandalonePwa();
}

/**
 * Safari·iOS PWA WebChannel: fetch streams / hanging GET 이 끊길 때
 * "XMLHttpRequest … due to access control checks" 가 콘솔에 남을 수 있습니다.
 * IndexedDB 캐시 + long-polling 고정 + useFetchStreams false 로 완화합니다.
 *
 * 웹에서는 enableNetwork/disableNetwork 토글 시 "Target ID already exists" 가
 * 발생하므로 사용하지 않습니다 (Firebase 지원팀 권고).
 */
const firestoreSettings = {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  }),
  // WebChannel 스트림이 끊기면 읽기가 영원히 pending — 자동 long-polling 전환
  experimentalAutoDetectLongPolling: true
};
if (isSafariLikeFirestoreClient()) {
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

export { app };
export const auth = getAuth(app);

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
