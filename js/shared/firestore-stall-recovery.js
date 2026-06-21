/**
 * Firestore 영속 캐시(IndexedDB)가 멈춰(hang) 응답이 없을 때 복구 수단을 제공합니다.
 * - 일정 시간 안에 첫 스냅샷이 안 오면 "연결 새로고침" 배너를 띄웁니다.
 * - 배너 클릭 시 Firestore IndexedDB 캐시를 비우고 새로고침합니다(서버 데이터는 안전).
 */

let clearing = false;

/** Firestore IndexedDB 캐시를 비우고 페이지를 새로고침 (서버 데이터는 그대로) */
export async function clearFirestoreCacheAndReload() {
  if (clearing) return;
  clearing = true;
  try {
    const list = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    const names = (list || [])
      .map((d) => d?.name || "")
      .filter((name) => /firestore|firebase/i.test(name));
    await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          })
      )
    );
  } catch (err) {
    console.warn("clearFirestoreCacheAndReload:", err);
  }
  location.reload();
}

let bannerEl = null;

export function hideFirestoreStallBanner() {
  if (bannerEl) {
    bannerEl.remove();
    bannerEl = null;
  }
}

export function showFirestoreStallBanner(
  message = "데이터를 불러오지 못했습니다. 연결을 새로고침해 주세요."
) {
  if (bannerEl) return;
  bannerEl = document.createElement("div");
  bannerEl.setAttribute("role", "alert");
  bannerEl.style.cssText =
    "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;" +
    "background:#1f2430;color:#fff;border:1px solid #3a4252;border-radius:10px;" +
    "padding:12px 16px;display:flex;gap:12px;align-items:center;max-width:92vw;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.45);font-size:14px;line-height:1.4;";

  const text = document.createElement("span");
  text.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "연결 새로고침";
  btn.style.cssText =
    "background:#d9a441;color:#1b1b1b;border:none;border-radius:8px;" +
    "padding:8px 14px;font-weight:700;cursor:pointer;white-space:nowrap;";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "새로고침 중…";
    void clearFirestoreCacheAndReload();
  });

  bannerEl.append(text, btn);
  document.body.appendChild(bannerEl);
}

/**
 * dataReady() 가 timeoutMs 안에 true 가 되지 않으면 onStall 을 호출합니다.
 * (데이터가 0건이어도 "스냅샷을 받았는지"로 판단해야 정상 빈 상태와 멈춤을 구분합니다.)
 * 반환된 함수를 호출하면 감시를 중단합니다.
 */
export function armFirestoreStallWatchdog({ timeoutMs = 10000, dataReady, onStall }) {
  const start = Date.now();
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    if (typeof dataReady === "function" && dataReady()) {
      stopped = true;
      clearInterval(timer);
      hideFirestoreStallBanner();
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      stopped = true;
      clearInterval(timer);
      try {
        onStall?.();
      } catch (err) {
        console.warn("firestore stall onStall:", err);
      }
    }
  }, 1000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
