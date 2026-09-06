importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

/** 배포마다 1 올리면 브라우저가 새 SW 로 인식해 controllerchange → 홈 화면 자동 새로고침이 걸립니다. */
const SW_DEPLOY_REVISION = 392;

/** SW 갱신 — 새 배포 즉시 활성화 (페이지 reload 루프는 LAST_TARGET 가드로 방지) */
self.addEventListener("install", (event) => {
  void SW_DEPLOY_REVISION;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          try {
            client.postMessage({ type: "HAN_PIT_SW_ACTIVATED" });
          } catch (_) {}
        }
      })
    )
  );
});

firebase.initializeApp({
  apiKey: "AIzaSyD6KXHIf1aaSDjbhHo8VtzbeMcaDIMP4SA",
  authDomain: "hanagency-c2c0e.firebaseapp.com",
  projectId: "hanagency-c2c0e",
  storageBucket: "hanagency-c2c0e.firebasestorage.app",
  messagingSenderId: "238155510408",
  appId: "1:238155510408:web:fbb571710c94d3fbb0e53d",
  measurementId: "G-N6FMJD2EHZ"
});

const messaging = firebase.messaging();

const NOTIFY_ICON = "./icons/icon-192.png";

/** GitHub Pages 서브경로(/Han-Pit/) — 상대 targetUrl 을 SW scope 기준 절대 URL 로 */
function resolveNotificationTargetUrl(raw) {
  const rel = String(raw || "").trim() || "./layout.html";
  if (/^https?:\/\//i.test(rel)) return rel;
  const scope = String(self.registration?.scope || "").trim();
  try {
    if (scope) return new URL(rel, scope).href;
  } catch (_) {}
  try {
    if (self.location?.href) return new URL(rel, self.location.href).href;
  } catch (_) {}
  return rel;
}

function showSeatNotificationFromPayload(data = {}, titleOverride = "") {
  const title = String(titleOverride || data.title || "").trim() || "Han Pit";
  const body =
    String(data.body || data.message || "").trim() || "좌석이 배치되었습니다.";
  const targetUrl = resolveNotificationTargetUrl(data.targetUrl || "./layout.html");
  const notifyTag =
    String(data.notifyTag || "").trim() ||
    (data.uid ? `hanpit-seat-${String(data.uid).trim()}` : "") ||
    "hanpit-seat";

  return self.registration.showNotification(title, {
    body,
    lang: "ko",
    tag: notifyTag,
    renotify: true,
    icon: NOTIFY_ICON,
    badge: NOTIFY_ICON,
    vibrate: [180, 80, 180],
    data: {
      targetUrl,
      appBadgeCount: data.appBadgeCount != null ? String(data.appBadgeCount) : ""
    }
  });
}


self.addEventListener("message", (event) => {
  const msg = event?.data;
  if (!msg || !msg.type) return;
  if (msg.type === "HAN_PIT_SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (msg.type !== "HAN_PIT_SHOW_NOTIFICATION") return;
  event.waitUntil(
    showSeatNotificationFromPayload(
      {
        title: msg.title,
        body: msg.body,
        targetUrl: msg.targetUrl,
        notifyTag: msg.tag,
        uid: msg.uid,
        appBadgeCount: msg.appBadgeCount
      },
      msg.title
    ).catch((e) => console.error("[firebase-messaging-sw.js] message notify:", e))
  );
});

function applyAppBadgeFromPayload(data) {
  if (!data) return Promise.resolve();
  const raw = data.appBadgeCount;
  // 빈 문자열은 "배지 없음"으로 처리하지 않음(iOS에서 잘못 clear 되는 것 방지)
  if (raw == null || raw === "") return Promise.resolve();
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return Promise.resolve();
  const capped = Math.min(99, n);
  // WebKit 권장: 홈 화면 웹앱의 SW 에서는 self.navigator 사용
  const nav = self.navigator;
  if (nav && typeof nav.setAppBadge === "function") {
    return nav.setAppBadge(capped).catch(() => {});
  }
  return Promise.resolve();
}

messaging.onBackgroundMessage((payload) => {
  console.debug("[firebase-messaging-sw.js] background message:", payload);

  const data = payload?.data || {};
  const title = String(data.title || payload?.notification?.title || "").trim() || "Han Pit";

  const nPromise = showSeatNotificationFromPayload(data, title).catch((e) => {
    console.error("[firebase-messaging-sw.js] showNotification failed:", e);
  });
  const badgeP = applyAppBadgeFromPayload(payload?.data || {});
  return Promise.all([nPromise, badgeP]);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = resolveNotificationTargetUrl(
    event.notification?.data?.targetUrl || "./layout.html"
  );

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (typeof client.navigate === "function") {
          // iOS WebKit 등에서 navigate() 가 조용히 실패/부분 반영되면 예전 화면에
          // 그대로 focus 만 되는 경우가 있어, 실패 시 새 창을 여는 걸로 대체한다.
          return client
            .navigate(targetUrl)
            .then((navigated) => (navigated || client).focus())
            .catch(() => (clients.openWindow ? clients.openWindow(targetUrl) : client.focus()));
        }
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});