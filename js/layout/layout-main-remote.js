import { db, auth } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function layoutLoadMyUserProfile() {
  if (!auth.currentUser) return null;

  try {
    const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
    if (!snap.exists()) return null;
    const { normalizeAndPersistUserRole } = await import("../login/user-sync.js");
    return await normalizeAndPersistUserRole(
      auth.currentUser.uid,
      snap.data() || {},
      auth.currentUser.email || ""
    );
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

export async function layoutLoadEventStateFromGlobalSeats(tournamentId = "", eventId = "", boxId = "") {
  const tid = String(tournamentId || "").trim();
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!tid || !eid || !bid) return null;

  try {
    const snap = await getDocs(
      query(
        collection(db, "tournaments", tid, "global_seats"),
        where("boxId", "==", bid)
      )
    );

    const seats = snap.docs
      .map((d) => d.data() || {})
      .filter((s) => {
        const mappedEventId = String(s.currentEventId || s.mappedEventId || "").trim();
        return mappedEventId === eid;
      })
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((s) => ({
        id: String(s.seatId || "").trim(),
        label: String(s.label || "").trim(),
        no: Number(s.no || 0) || 0,
        order: Number(s.order || 0) || 0,
        person: String(s.person || "").trim() || "비어있음",
        personUid: String(s.personUid || "").trim(),
        personEmail: String(s.personEmail || "").trim(),
        seatedAt: s.seatedAt ? Number(s.seatedAt) : null,
        x: Number(s.x || 0) || 0,
        y: Number(s.y || 0) || 0
      }))
      .filter((s) => s.id);

    if (!seats.length) return null;
    const maxNo = seats.reduce((m, s) => Math.max(m, Number(s.no || 0)), 0);
    const maxOrder = seats.reduce((m, s) => Math.max(m, Number(s.order || 0)), 0);

    return {
      version: 2,
      tournamentId: tid,
      eventId: eid,
      boxId: bid,
      seats,
      nextSeatNo: maxNo + 1,
      nextSeatOrder: maxOrder + 1,
      updatedAt: Date.now()
    };
  } catch (err) {
    console.error("layoutLoadEventStateFromGlobalSeats error:", err);
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
