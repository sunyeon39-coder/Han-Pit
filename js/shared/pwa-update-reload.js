/**
 * 홈 화면(standalone) 웹앱: Service Worker 가 새 버전으로 바뀌면 한 번 새로고침해
 * 오래 붙잡은 JS/HTML 탭을 갱신합니다. (FCM SW 업데이트 시)
 *
 * 앱 JS만 바뀌고 SW 바이트는 그대로인 경우 controllerchange 가 안 나므로,
 * standalone 에서는 포그라운드 복귀마다 registration.update() 로 SW 재검사를 걸어둡니다.
 * (실제 번들 갱신은 Hosting Cache-Control 에 의존)
 */
function isStandaloneDisplayMode() {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.bind(window);
  if (!mm) return false;
  return (
    mm("(display-mode: standalone)")?.matches === true ||
    mm("(display-mode: fullscreen)")?.matches === true ||
    mm("(display-mode: minimal-ui)")?.matches === true
  );
}

function isIosHomeScreenWebApp() {
  return typeof navigator !== "undefined" && navigator.standalone === true;
}

function isStandalonePwaShell() {
  return isStandaloneDisplayMode() || isIosHomeScreenWebApp();
}

function requestServiceWorkerUpdateCheck() {
  if (!navigator.serviceWorker?.getRegistration) return;
  void navigator.serviceWorker.getRegistration().then((reg) => {
    void reg?.update();
  });
}

if (typeof navigator !== "undefined" && navigator.serviceWorker?.addEventListener) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    if (!isStandalonePwaShell()) return;
    reloaded = true;
    window.location.reload();
  });
}

if (typeof window !== "undefined" && isStandalonePwaShell()) {
  const scheduleUpdateCheck = () => {
    if (document.visibilityState === "visible") {
      requestServiceWorkerUpdateCheck();
    }
  };
  document.addEventListener("visibilitychange", scheduleUpdateCheck);
  window.addEventListener("pageshow", () => {
    requestServiceWorkerUpdateCheck();
  });
  window.addEventListener("focus", scheduleUpdateCheck);
  scheduleUpdateCheck();
}
