/**
 * 홈 화면(standalone) 웹앱: Service Worker 가 새 버전으로 바뀌면 한 번 새로고침해
 * 오래 붙잡은 JS/HTML 탭을 갱신합니다. (FCM SW 업데이트 시)
 */
if (typeof navigator !== "undefined" && navigator.serviceWorker?.addEventListener) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    const standalone =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
        window.matchMedia?.("(display-mode: fullscreen)")?.matches === true);
    const iosStandalone = typeof navigator !== "undefined" && navigator.standalone === true;
    if (!standalone && !iosStandalone) return;
    reloaded = true;
    window.location.reload();
  });
}
