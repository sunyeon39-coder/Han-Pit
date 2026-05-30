/**
 * 배포 후 기존·신규 사용자 모두 최신 HTML/JS 로 맞춤.
 * - HTML 인라인 스크립트(모듈 전) + 이 모듈 이중 확인
 * - SW activate / controllerchange 시 강제 갱신
 */
const VERSION_URL = "./app-version.json";
const VERSION_STORAGE_KEY = "hanPitAppVersion";
const VERSION_CHECK_INTERVAL_MS = 12_000;
const BUILD_META_SELECTOR = 'meta[name="han-pit-build"]';

function getPageBuildVersion() {
  const el = document.querySelector(BUILD_META_SELECTOR);
  return String(el?.getAttribute("content") || "").trim();
}

function requestServiceWorkerUpdateCheck() {
  if (!navigator.serviceWorker?.register) return;
  void navigator.serviceWorker
    .register("./firebase-messaging-sw.js", { scope: "./" })
    .then((reg) => reg.update())
    .catch(() => {});
}

async function fetchRemoteAppVersion() {
  try {
    const url = `${VERSION_URL}?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    const v = String(data?.v ?? data?.version ?? "").trim();
    return v || null;
  } catch {
    return null;
  }
}

let versionCheckInflight = false;
let swReloaded = false;

function persistAppVersion(v) {
  try {
    localStorage.setItem(VERSION_STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

function readStoredAppVersion() {
  try {
    return String(localStorage.getItem(VERSION_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function reloadForAppVersion(v) {
  if (!v) {
    window.location.reload();
    return;
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get("_hanpit_v") === v) {
    const pageBuild = getPageBuildVersion();
    if (pageBuild === v) return;
  }

  const attemptKey = `hanPitReloadAttempt:${v}`;
  let attempts = 0;
  try {
    attempts = Number(sessionStorage.getItem(attemptKey) || 0);
  } catch {
    attempts = 0;
  }
  const maxAttempts = isLegacyIndexShell() || !getPageBuildVersion() ? 12 : 4;
  if (attempts >= maxAttempts) return;
  try {
    sessionStorage.setItem(attemptKey, String(attempts + 1));
  } catch {
    /* ignore */
  }

  persistAppVersion(v);
  url.searchParams.set("_hanpit_v", v);
  window.location.replace(url.toString());
}

function isLegacyIndexShell() {
  const onIndexPage =
    document.getElementById("indexRoot") || document.getElementById("dealerOpsMount");
  return Boolean(onIndexPage) && !document.getElementById("workSummaryModal");
}

async function checkAppVersionAndReloadIfNeeded() {
  if (versionCheckInflight) return;
  versionCheckInflight = true;
  try {
    if (isLegacyIndexShell()) {
      const remote = await fetchRemoteAppVersion();
      reloadForAppVersion(remote || String(Date.now()));
      return;
    }

    const remote = await fetchRemoteAppVersion();
    if (!remote) return;

    const pageBuild = getPageBuildVersion();
    const stored = readStoredAppVersion();
    const bustParam = new URL(window.location.href).searchParams.get("_hanpit_v");

    if (bustParam === remote && pageBuild && pageBuild === remote && !isLegacyIndexShell()) {
      persistAppVersion(remote);
      return;
    }

    const pageStale = !pageBuild || (Boolean(pageBuild) && pageBuild !== remote);
    const storedStale = Boolean(stored) && stored !== remote;
    const neverSynced = !stored;
    const missingPageMeta = !pageBuild;
    const bustStale = Boolean(bustParam) && bustParam !== remote;

    if (pageStale || storedStale || neverSynced || missingPageMeta || bustStale) {
      reloadForAppVersion(remote);
    }
  } finally {
    versionCheckInflight = false;
  }
}

function scheduleVersionAndSwCheck() {
  if (document.visibilityState !== "visible") return;
  requestServiceWorkerUpdateCheck();
  void checkAppVersionAndReloadIfNeeded();
}

function onSwForceReloadMessage(ev) {
  const data = ev?.data;
  if (!data || data.type !== "HAN_PIT_FORCE_RELOAD") return;
  const v = String(data.v || "").trim();
  reloadForAppVersion(v || undefined);
}

if (typeof navigator !== "undefined" && navigator.serviceWorker?.addEventListener) {
  navigator.serviceWorker.addEventListener("message", onSwForceReloadMessage);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloaded) return;
    swReloaded = true;
    void fetchRemoteAppVersion().then((v) => reloadForAppVersion(v || undefined));
  });
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", scheduleVersionAndSwCheck);
  window.addEventListener("pageshow", scheduleVersionAndSwCheck);
  window.addEventListener("focus", scheduleVersionAndSwCheck);
  document.addEventListener("DOMContentLoaded", scheduleVersionAndSwCheck);
  scheduleVersionAndSwCheck();

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      scheduleVersionAndSwCheck();
    }
  }, VERSION_CHECK_INTERVAL_MS);
}
