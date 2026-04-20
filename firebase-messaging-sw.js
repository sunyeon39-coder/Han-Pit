importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

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

messaging.onBackgroundMessage((payload) => {
  console.debug("[firebase-messaging-sw.js] background message:", payload);

  const title = payload?.notification?.title || "BoxBoard";
  const body =
    payload?.notification?.body ||
    payload?.data?.message ||
    "Seat에 배치되었습니다.";

  const targetUrl = payload?.data?.targetUrl || "./layout.html";

  // icon 경로 없이 표시 (repo에 ./icons 미포함 시 404로 알림 실패 방지)
  self.registration.showNotification(title, {
    body,
    data: {
      targetUrl
    }
  });
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