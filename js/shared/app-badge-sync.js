import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { clearDocumentTitleBadge } from "./fcm-web-push.js";

let lastPersistUid = "";
let lastPersistAt = 0;

async function clearAppBadgePersisted(db, uid) {
  if (!db || !uid) return;
  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav && typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
    }
  } catch (_) {}
  clearDocumentTitleBadge();
  // 화면 전환마다 users 문서를 쓰면 프로필 실시간 구독이 매번 다시 돌아 읽기가 늘어난다 — 30초에 한 번만
  const now = Date.now();
  if (lastPersistUid === uid && now - lastPersistAt < 30_000) return;
  lastPersistUid = uid;
  lastPersistAt = now;
  try {
    await setDoc(doc(db, "users", uid), { appBadgeCount: 0 }, { merge: true });
  } catch (err) {
    console.debug("[app-badge-sync] reset count", err?.code || err);
  }
}

/**
 * 홈 화면 아이콘 배지(Badging API)를 앱이 다시 보일 때 초기화하고 Firestore `appBadgeCount` 도 0으로 맞춤.
 * @returns {() => void} 같은 탭에서 인증 직후 한 번 더 호출해 두면(포그라운드일 때) 첫 진입에서도 배지가 지워집니다.
 */
export function bindAppBadgeClearOnForeground(db, auth) {
  if (typeof document === "undefined" || !db || !auth) {
    return () => {};
  }

  function flushIfVisible() {
    if (document.visibilityState !== "visible") return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    void clearAppBadgePersisted(db, uid);
  }

  if (!globalThis.__hanPitAppBadgeClearBound) {
    globalThis.__hanPitAppBadgeClearBound = true;
    document.addEventListener("visibilitychange", flushIfVisible);
    window.addEventListener("pageshow", flushIfVisible);
  }

  return flushIfVisible;
}
