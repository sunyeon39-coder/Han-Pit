importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

/** 배포마다 1 올리면 브라우저가 새 SW 로 인식해 controllerchange → 홈 화면 자동 새로고침이 걸립니다. */
const SW_DEPLOY_REVISION = 43;

/** SW 갱신 시 홈 화면 웹앱이 오래된 탭에 머물지 않도록 즉시 활성화 */
self.addEventListener("install", (event) => {
  void SW_DEPLOY_REVISION;
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const version = await fetchDeployAppVersion();
      await notifyClientsToReload(version || String(Date.now()));
    })()
  );
});

/** PWA가 HTML/문서를 디스크 캐시에 묶지 않도록 네트워크 우선 */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isDoc =
    event.request.mode === "navigate" ||
    event.request.destination === "document" ||
    /\.html?$/i.test(url.pathname);
  if (!isDoc) return;
  event.respondWith(
    fetch(event.request, { cache: "no-store" }).catch(() => fetch(event.request))
  );
});
async function fetchDeployAppVersion() {
  try {
    const res = await fetch("./app-version.json", { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data?.v ?? data?.version ?? "").trim();
  } catch {
    return "";
  }
}

function buildBustedClientUrl(clientUrl, version) {
  const url = new URL(clientUrl);
  if (version) url.searchParams.set("_hanpit_v", version);
  return url.toString();
}

async function notifyClientsToReload(version) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
  await Promise.all(
    clients.map(async (client) => {
      const busted = buildBustedClientUrl(client.url, version);
      if (typeof client.navigate === "function" && busted !== client.url) {
        try {
          await client.navigate(busted);
          return;
        } catch {
          /* fall through to postMessage */
        }
      }
      try {
        client.postMessage({ type: "HAN_PIT_FORCE_RELOAD", v: version });
      } catch {
        /* ignore */
      }
    })
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const version = await fetchDeployAppVersion();
      await notifyClientsToReload(version || String(Date.now()));
    })()
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
  const body =
    String(data.body || payload?.notification?.body || data.message || "").trim() ||
    "좌석이 배치되었습니다.";

  const targetUrl = data.targetUrl || "./layout.html";
  const notifyTag = String(data.dedupKey || "").trim() || "hanpit-seat";

  const noteData = {
    targetUrl,
    appBadgeCount: data.appBadgeCount != null ? String(data.appBadgeCount) : ""
  };

  // data-only FCM: SW에서만 1회 표시 (notification 페이로드 자동 표시와 중복 방지)
  const nPromise = Promise.resolve().then(() => {
    try {
      return self.registration.showNotification(title, {
        body,
        lang: "ko",
        tag: notifyTag,
        renotify: false,
        vibrate: [180, 80, 180],
        data: noteData
      });
    } catch (e) {
      console.error("[firebase-messaging-sw.js] showNotification failed:", e);
    }
  });
  const badgeP = applyAppBadgeFromPayload(payload?.data || {});
  return Promise.all([nPromise, badgeP]);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.targetUrl || "./layout.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (typeof client.navigate === "function") {
          return client.navigate(targetUrl).then(() => client.focus());
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