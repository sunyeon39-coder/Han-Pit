import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { isSeatAssignedToCurrentUser } from "../layout/layout-main-identity.js";

/** 배치 직후 낙관적 알림 — 이 시간 안의 좌석만 알림 대상 */
export const RECENT_SEAT_ASSIGN_ALERT_MS = 15000;

const shownOptimisticKeys = new Set();

export function buildSeatAssignmentStableKey({
  uid = "",
  eventId = "",
  boxId = "",
  seatId = ""
} = {}) {
  return `${String(uid || "").trim()}:${String(eventId || "").trim()}:${String(boxId || "").trim()}:${String(seatId || "").trim()}`;
}

export function buildOptimisticSeatAlertKey(payload = {}) {
  return `opt:${buildSeatAssignmentStableKey(payload)}`;
}

export function markOptimisticSeatAlertShown(key = "") {
  const k = String(key || "").trim();
  if (k) shownOptimisticKeys.add(k);
}

export function wasOptimisticSeatAlertShown(key = "") {
  return shownOptimisticKeys.has(String(key || "").trim());
}

export function shouldUseOptimisticSeatAlertOnMobile() {
  return layoutIsMobile();
}

export function findCurrentUserSeat(seats = [], user, profile) {
  if (!user || !Array.isArray(seats)) return null;
  return seats.find((seat) => isSeatAssignedToCurrentUser(seat, user, profile)) || null;
}

let mobileAlertHandler = null;

export function registerOptimisticSeatAssignedAlertHandler(fn) {
  mobileAlertHandler = typeof fn === "function" ? fn : null;
}

export function triggerOptimisticMobileSeatAssignedAlert(payload = {}) {
  if (!shouldUseOptimisticSeatAlertOnMobile()) return false;
  if (typeof mobileAlertHandler !== "function") return false;

  const uid = String(payload.uid || "").trim();
  const eventId = String(payload.eventId || "").trim();
  const boxId = String(payload.boxId || "").trim();
  const seatId = String(payload.seatId || "").trim();
  if (!uid || !seatId) return false;

  const optKey = buildOptimisticSeatAlertKey({ uid, eventId, boxId, seatId });
  if (wasOptimisticSeatAlertShown(optKey)) return false;

  const shown = mobileAlertHandler({ ...payload, uid, eventId, boxId, seatId }) === true;
  if (shown) markOptimisticSeatAlertShown(optKey);
  return shown;
}

export function shouldSkipSeatNotificationSnapshotAfterOptimistic({
  activeNotificationId = "",
  uid = "",
  eventId = "",
  boxId = "",
  seatId = ""
} = {}) {
  const optKey = buildOptimisticSeatAlertKey({ uid, eventId, boxId, seatId });
  if (!wasOptimisticSeatAlertShown(optKey)) return false;
  return activeNotificationId === optKey || String(activeNotificationId || "").startsWith("opt:");
}

/** 좌석 스냅샷에서 본인 배치를 감지해 낙관적 알림 (원격 배치·Firestore 알림 doc 지연 대비) */
export function maybeShowOptimisticSeatAlertFromSeats(seats = [], options = {}) {
  const {
    user,
    profile,
    eventId = "",
    boxId = "",
    eventTitle = "",
    buildTargetUrl,
    showAlert
  } = options;

  if (!shouldUseOptimisticSeatAlertOnMobile()) return false;
  if (!user?.uid || typeof showAlert !== "function") return false;

  const seat = findCurrentUserSeat(seats, user, profile);
  if (!seat) return false;

  const seatId = String(seat.id || seat.seatId || "").trim();
  if (!seatId) return false;

  const ev = String(eventId || seat.currentEventId || seat.mappedEventId || "").trim();
  const bx = String(boxId || seat.boxId || "").trim();
  const seatedAt = Number(seat.seatedAt || 0);
  if (seatedAt > 0 && Date.now() - seatedAt > RECENT_SEAT_ASSIGN_ALERT_MS) return false;

  const uid = String(user.uid || "").trim();
  const optKey = buildOptimisticSeatAlertKey({ uid, eventId: ev, boxId: bx, seatId });
  if (wasOptimisticSeatAlertShown(optKey)) return false;

  const seatLabel = String(seat.label ?? seat.no ?? "").trim();
  const targetUrl =
    typeof buildTargetUrl === "function" ? String(buildTargetUrl(ev, bx, seatId) || "").trim() : "";

  return showAlert({
    uid,
    eventId: ev,
    boxId: bx,
    seatId,
    seatLabel,
    eventTitle,
    targetUrl
  });
}
