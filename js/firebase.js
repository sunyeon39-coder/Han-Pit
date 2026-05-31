import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
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

/**
 * Safari·iOS PWA: WebChannel(Fetch Streams)이
 * "XMLHttpRequest … due to access control checks" 로 끊기는 문제 완화.
 * Listen·Write 채널 모두 long-polling + 비-stream 모드로 고정합니다.
 *
 * - experimentalAutoDetectLongPolling 과 force 를 동시에 켜면 충돌할 수 있어 detect 는 끔
 * - 모바일에서 PC 127.0.0.1 로 접속하면 별도 네트워크/CORS 이슈가 날 수 있음 → Pages URL 사용
 */
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false,
  useFetchStreams: false,
  experimentalLongPollingOptions: {
    timeoutSeconds: 25
  }
});

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
