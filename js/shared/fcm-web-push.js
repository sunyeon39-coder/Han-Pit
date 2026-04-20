/**
 * Firebase Web Push (FCM) — 모바일 백그라운드 알림용.
 * Android(삼성 포함) Chrome·iOS Safari 16.4+ (홈 화면 추가 시 권장).
 */
import { db, getMessagingSafe } from "../firebase.js";
import { getToken } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";
import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const FCM_VAPID_KEY =
  "BAZXsr3GQtq_nPLrF7C89mr3ejM7DbS-cBBfWNZzHfcHggNier7C2fbIG0uex3DZl8ykVxbqrli54cCdLkena94";

export function isWebPushEnvironmentOk() {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("Notification" in window)) return false;
  return true;
}

export async function saveUserFcmToken(uid, token) {
  if (!uid || !token) return;
  await setDoc(
    doc(db, "users", uid),
    {
      fcmToken: token,
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

/**
 * 권한이 이미 granted 인 경우 토큰만 갱신해 Firestore에 저장 (무음).
 */
export async function refreshFcmTokenIfGranted(uid) {
  if (!uid || !isWebPushEnvironmentOk()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  try {
    const messaging = await getMessagingSafe();
    if (!messaging) return;

    let registration = await navigator.serviceWorker.getRegistration("./");
    if (!registration) {
      registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js", {
        scope: "./"
      });
    }
    await navigator.serviceWorker.ready;

    const token = await getToken(messaging, {
      vapidKey: FCM_VAPID_KEY,
      serviceWorkerRegistration: registration
    });
    if (token) await saveUserFcmToken(uid, token);
  } catch (err) {
    console.debug("[fcm-web-push] refreshFcmTokenIfGranted:", err);
  }
}

/**
 * 알림 권한 요청(필요 시) → SW 등록 → FCM 토큰 발급 → users 문서에 저장.
 * iOS Safari 는 사용자 탭(제스처) 안에서 호출하는 것이 안전합니다.
 */
export async function registerFcmWebPushAndSave(uid, vapidKey = FCM_VAPID_KEY) {
  if (!uid) return { ok: false, reason: "no_uid" };
  if (!isWebPushEnvironmentOk()) return { ok: false, reason: "unsupported" };

  try {
    const messaging = await getMessagingSafe();
    if (!messaging) return { ok: false, reason: "no_messaging" };

    if (Notification.permission === "denied") {
      return { ok: false, reason: "denied" };
    }

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      return { ok: false, reason: "not_granted" };
    }

    let registration = await navigator.serviceWorker.getRegistration("./");
    if (!registration) {
      registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js", {
        scope: "./"
      });
    }
    await navigator.serviceWorker.ready;

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration
    });
    if (!token) return { ok: false, reason: "no_token" };

    await saveUserFcmToken(uid, token);
    return { ok: true, token };
  } catch (err) {
    console.error("[fcm-web-push] registerFcmWebPushAndSave:", err);
    return { ok: false, reason: "error", error: err };
  }
}

/**
 * @param {HTMLButtonElement | null} button
 * @param {string} [uid]
 */
export function syncPushOfferButton(button, uid) {
  if (!button) return;
  if (!uid || !isWebPushEnvironmentOk()) {
    button.classList.add("hidden");
    return;
  }
  button.classList.remove("hidden");

  const p = Notification.permission;
  if (p === "granted") {
    button.textContent = "알림 켜짐";
    button.disabled = true;
    button.title =
      "백그라운드 푸시가 켜져 있습니다. iPhone은 Safari에서 홈 화면에 추가하면 더 안정적입니다 (iOS 16.4+).";
  } else if (p === "denied") {
    button.textContent = "알림 차단됨";
    button.disabled = true;
    button.title = "브라우저 또는 기기 설정에서 이 사이트의 알림을 허용해 주세요.";
  } else {
    button.textContent = "알림 켜기";
    button.disabled = false;
    button.title =
      "앱을 나가 있어도 좌석 배정 등 알림을 받습니다. (Android·iPhone 지원, iPhone은 홈 화면 추가 권장)";
  }
}
