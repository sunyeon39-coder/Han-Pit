import { db, auth } from "../firebase.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function layoutLoadMyUserProfile() {
  if (!auth.currentUser) return null;

  try {
    const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    console.error("loadMyUserProfile error:", err);
    return null;
  }
}

export async function layoutLoadEventStateRemote(eventRef) {
  try {
    const snap = await getDoc(eventRef);
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    console.error("loadEventStateRemote error:", err);
    return null;
  }
}

export async function layoutLoadWaitingStateRemote(waitingRef) {
  try {
    const snap = await getDoc(waitingRef);
    if (!snap.exists()) return null;
    return snap.data() || null;
  } catch (err) {
    console.error("loadWaitingStateRemote error:", err);
    return null;
  }
}

export async function layoutAcknowledgeMyNotification(currentUser) {
  if (!currentUser) return;

  try {
    await setDoc(
      doc(db, "layout_notifications", currentUser.uid),
      {
        acknowledged: true,
        acknowledgedAt: Date.now(),
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("acknowledgeMyNotification error:", err);
  }
}

export async function layoutRefreshCachedEventCardTitle(tournamentId, eventId, cacheHolder) {
  cacheHolder.cachedEventCardTitle = "";
  if (!tournamentId || !eventId) return;
  try {
    const snap = await getDoc(doc(db, "tournaments", tournamentId, "events", eventId));
    if (!snap.exists()) return;
    const title = String((snap.data() || {}).title || "").trim();
    if (title) cacheHolder.cachedEventCardTitle = title;
  } catch (err) {
    console.error("refreshCachedEventCardTitle error:", err);
  }
}

/**
 * users 문서 조회 없이 표시명 결정 (layoutGetBestDisplayName 의 Firestore 실패·미존재 시와 동일 규칙).
 * @param {string} fallbackEmail
 * @param {string} fallbackName
 */
export function layoutSyncDisplayNameFallback(fallbackEmail = "", fallbackName = "") {
  const safeEmail = String(fallbackEmail || "").trim();
  const safeName = String(fallbackName || "").trim();

  if (safeName && !safeName.includes("@")) return safeName;
  if (safeEmail) return safeEmail;
  return safeName || "Dealer";
}

export async function layoutGetBestDisplayName(uid = "", fallbackEmail = "", fallbackName = "") {
  const safeUid = String(uid || "").trim();
  const safeEmail = String(fallbackEmail || "").trim();
  const safeName = String(fallbackName || "").trim();

  if (safeUid) {
    try {
      const snap = await getDoc(doc(db, "users", safeUid));
      if (snap.exists()) {
        const data = snap.data() || {};
        const nickname = String(data.nickname || "").trim();
        if (nickname) return nickname;
      }
    } catch (err) {
      console.error("getBestDisplayName error:", err);
    }
  }

  return layoutSyncDisplayNameFallback(safeEmail, safeName);
}
