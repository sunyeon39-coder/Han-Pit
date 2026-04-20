/**
 * Firebase Web Push (FCM) — 모바일 백그라운드 알림용.
 * - Android: Chrome에서 사이트 알림 허용 + 배터리 제한 완화 권장.
 * - iPhone: iOS 16.4+ Safari로 **홈 화면에 추가**한 웹앱에서만 푸시·백그라운드 알림.
 *   (일반 Safari 탭·iOS Chrome 탭은 Apple 정책상 FCM 웹 푸시 불가)
 */
import { db, getMessagingSafe } from "../firebase.js";
import { getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js";
import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const FCM_VAPID_KEY =
  "BAZXsr3GQtq_nPLrF7C89mr3ejM7DbS-cBBfWNZzHfcHggNier7C2fbIG0uex3DZl8ykVxbqrli54cCdLkena94";

let foregroundBadgeListenerBound = false;

/** 앱이 켜져 있을 때 수신되는 FCM 에도 아이콘 배지 숫자 반영 (백그라운드 SW 와 동일 data). */
export async function ensureForegroundFcmBadgeListener() {
  if (foregroundBadgeListenerBound || typeof window === "undefined") return;
  const messaging = await getMessagingSafe();
  if (!messaging) return;
  foregroundBadgeListenerBound = true;
  onMessage(messaging, (payload) => {
    const raw = payload?.data?.appBadgeCount;
    if (raw == null || raw === "") return;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return;
    if ("setAppBadge" in navigator) {
      void navigator.setAppBadge(Math.min(99, n)).catch(() => {});
    }
  });
}

function isLikelyIosNonSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  return /CriOS|FxiOS|OPiOS|EdgiOS/i.test(ua);
}

/** FCM 토큰 발급·권한 요청까지 가능한 환경 (Notification API 포함). */
export function isWebPushEnvironmentOk() {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("Notification" in window)) return false;
  return true;
}

/**
 * 알림 버튼을 보여줄지 여부. iOS Safari 일반 탭에는 `Notification`이 없어도
 * 서비스워커+HTTPS이면 버튼을 노출하고, 탭 시 홈 화면 추가 안내로 유도한다.
 */
export function isWebPushUiOfferable() {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator)) return false;
  return true;
}

/**
 * @param {{ ok: boolean, reason?: string }} r
 */
export function alertFcmRegistrationResult(r) {
  if (!r) return;
  if (r.ok) {
    alert("백그라운드 알림이 켜졌습니다.");
    return;
  }
  if (r.reason === "denied") {
    alert("알림이 차단되어 있습니다. 기기 설정에서 이 브라우저의 알림을 허용해 주세요.");
    return;
  }
  if (r.reason === "not_granted") {
    alert("알림 권한을 허용해 주세요.");
    return;
  }
  if (r.reason === "no_notification_api") {
    alert(
      "이 탭에서는 웹 알림을 켤 수 없습니다. iPhone·iPad Safari에서는 공유(□↑) → 「홈 화면에 추가」로 설치한 뒤, 홈 화면 아이콘으로 연 앱에서 다시 「알림 켜기」를 눌러 주세요. (iOS 16.4 이상) 카카오톡·라인 등 인앱 브라우저는 Safari 또는 Chrome으로 열어 주세요."
    );
    return;
  }
  if (r.reason === "unsupported") {
    alert("이 환경에서는 웹 푸시를 사용할 수 없습니다. (HTTPS 또는 localhost 필요)");
    return;
  }
  if (r.reason === "no_messaging") {
    if (isLikelyIosNonSafariBrowser()) {
      alert(
        "iPhone·iPad의 Chrome 등 서드파티 브라우저는 Apple 정책으로 웹 푸시(FCM)를 사용할 수 없습니다.\n\n**Safari**로 이 사이트를 연 뒤, 공유(□↑) → 「홈 화면에 추가」로 설치하고, 홈 화면 아이콘에서 「알림 켜기」를 다시 눌러 주세요."
      );
    } else {
      alert(
        "이 브라우저에서는 Firebase 웹 푸시를 지원하지 않습니다. Chrome·Edge 최신 버전 또는 iPhone Safari(홈 화면 웹앱 권장)에서 다시 시도해 주세요."
      );
    }
    return;
  }
  if (r.reason === "no_token") {
    alert(
      "푸시 등록 토큰을 받지 못했습니다. iPhone은 Safari에서 홈 화면에 추가한 뒤 다시 시도하거나, 잠시 후 같은 버튼을 한 번 더 눌러 주세요."
    );
    return;
  }
  if (r.reason === "error") {
    const code = r.error && typeof r.error === "object" ? r.error.code : "";
    const hint =
      isLikelyIosNonSafariBrowser() || /ios|unsupported-browser|messaging/i.test(String(code))
        ? " iPhone Chrome이 아니라 Safari(또는 홈 화면 웹앱)에서 시도해 주세요."
        : "";
    alert(`알림 등록 중 오류가 발생했습니다.${hint} 잠시 후 다시 시도해 주세요.`);
    return;
  }
  alert("알림 설정에 실패했습니다. 잠시 후 다시 시도해 주세요.");
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
    if (token) {
      await saveUserFcmToken(uid, token);
      void ensureForegroundFcmBadgeListener();
    }
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
  if (!isWebPushUiOfferable()) return { ok: false, reason: "unsupported" };
  if (!("Notification" in window)) return { ok: false, reason: "no_notification_api" };

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
    void ensureForegroundFcmBadgeListener();
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
  if (!uid || !isWebPushUiOfferable()) {
    button.classList.add("hidden");
    return;
  }
  button.classList.remove("hidden");

  if (!("Notification" in window)) {
    button.textContent = "알림 켜기";
    button.disabled = false;
    button.title =
      "iPhone·iPad Safari 일반 탭에는 알림이 비활성화됩니다. 공유 → 홈 화면에 추가 후 아이콘으로 다시 열어 주세요. (iOS 16.4+)";
    return;
  }

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
