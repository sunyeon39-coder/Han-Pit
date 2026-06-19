/**
 * hub 등 layout 이 아닌 페이지에서 layout_notifications 를 구독합니다.
 * 백그라운드 OS 알림은 FCM(service worker)만 사용 — onSnapshot 중복 방지.
 */
import { db } from "../firebase.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { buildSeatAssignedNotifyMessage } from "./seat-notification-label.js";
import {
  buildSeatNotifyTag,
  isStaleSeatNotification,
  seatNotificationKey
} from "./seat-notification-push.js";
import { showSeatAssignedOsNotification } from "./fcm-web-push.js";

let stopWatch = null;
let watchUid = "";
let activeNotificationKey = "";

function isDedicatedLayoutNotificationPage() {
  const path = String(location.pathname || "").toLowerCase();
  return path.endsWith("/layout.html") || path.endsWith("/global-layout.html");
}

function isPageBackgroundForPush() {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "hidden" || !document.hasFocus();
}

async function applySeatNotificationSnap(snap, uid) {
  if (!uid || isDedicatedLayoutNotificationPage()) return;

  if (!snap.exists()) {
    activeNotificationKey = "";
    return;
  }

  const data = snap.data() || {};
  if (String(data.type || "").trim() !== "seat_assigned" || data.acknowledged === true) {
    activeNotificationKey = "";
    return;
  }

  const createdMs = Number(data.createdAt);
  if (isStaleSeatNotification(createdMs)) return;

  const notificationKey = seatNotificationKey(uid, data);
  if (activeNotificationKey === notificationKey) return;
  activeNotificationKey = notificationKey;

  if (isPageBackgroundForPush()) return;

  const body = buildSeatAssignedNotifyMessage({
    eventId: data.eventId,
    eventTitle: data.eventTitle,
    seatLabel: data.seatLabel
  });
  const targetUrl = String(data.targetUrl || "").trim() || "./layout.html";

  await showSeatAssignedOsNotification({
    title: "배치 알림",
    body,
    targetUrl,
    uid,
    tag: buildSeatNotifyTag(uid)
  });
}

export function bindGlobalSeatNotificationWatch(user) {
  if (!user?.uid) {
    disposeGlobalSeatNotificationWatch();
    return;
  }
  if (isDedicatedLayoutNotificationPage()) return;

  const uid = user.uid;
  if (watchUid === uid && stopWatch) return;

  disposeGlobalSeatNotificationWatch();
  watchUid = uid;

  const ref = doc(db, "layout_notifications", uid);
  stopWatch = onSnapshot(
    ref,
    (snap) => {
      void applySeatNotificationSnap(snap, uid);
    },
    (err) => {
      console.error("[global-seat-notify] watch error:", err);
    }
  );

  void getDoc(ref)
    .then((snap) => applySeatNotificationSnap(snap, uid))
    .catch((err) => console.warn("[global-seat-notify] initial read:", err));
}

export function disposeGlobalSeatNotificationWatch() {
  if (stopWatch) {
    stopWatch();
    stopWatch = null;
  }
  watchUid = "";
  activeNotificationKey = "";
}

export function wireGlobalSeatNotificationVisibilityResync(user) {
  if (typeof document === "undefined" || !user?.uid) return;

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    const uid = user.uid;
    void getDoc(doc(db, "layout_notifications", uid))
      .then((snap) => applySeatNotificationSnap(snap, uid))
      .catch(() => {});
  };

  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
