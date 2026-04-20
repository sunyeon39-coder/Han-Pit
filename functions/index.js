/**
 * layout_notifications/{uid} 에 seat_assigned 가 기록되면 users/{uid}.fcmToken 으로 FCM 전송.
 * (레이아웃 / 통합 배치도 / 동일 Firestore 경로를 쓰는 모든 배치 흐름 공통 처리)
 *
 * 배포: Blaze 플랜에서
 *   cd functions && npm install && cd .. && firebase deploy --only functions
 *
 * 알림 클릭 시 열릴 절대 URL을 쓰려면 functions/.env 에 다음을 넣고 배포하세요:
 *   APP_ORIGIN=https://sunyeon39-coder.github.io/Han-Pit
 * (끝에 슬래시 없이, GitHub Pages 실제 호스트로 맞춤)
 */
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

setGlobalOptions({region: "asia-northeast3"});

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

function toMillis(v) {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  return 0;
}

function buildDedupKey(uid, after) {
  const createdMs = toMillis(after.createdAt);
  const eventId = String(after.eventId || "").trim();
  const boxId = String(after.boxId || "").trim();
  const seatId = String(after.seatId || "").trim();
  return `${uid}|${createdMs}|${eventId}|${boxId}|${seatId}`;
}

function resolveTargetUrlForPush(raw) {
  const u = String(raw || "").trim() || "./layout.html";
  const origin = String(process.env.APP_ORIGIN || "").trim();
  if (!origin) return u;
  try {
    const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
    return new URL(u, `${base}/`).href;
  } catch (_) {
    return u;
  }
}

exports.notifyLayoutSeatAssigned = onDocumentWritten("layout_notifications/{uid}", async (event) => {
  const change = event.data;
  if (!change.after.exists) return;

  const after = change.after.data();
  if (!after) return;

  if (String(after.type || "").trim() !== "seat_assigned") return;
  if (after.acknowledged === true) return;

  const uid = String(event.params.uid || "").trim();
  if (!uid) return;

  const dedupKey = buildDedupKey(uid, after);
  if (String(after.fcmSeatNotifyDedupKey || "") === dedupKey) return;

  const userSnap = await db.doc(`users/${uid}`).get();
  const token = userSnap.exists ? String(userSnap.get("fcmToken") || "").trim() : "";
  if (!token) {
    await change.after.ref.set({fcmSeatNotifyDedupKey: dedupKey}, {merge: true});
    return;
  }

  const title = "배치 알림";
  const body = String(after.message || "").trim() || "Seat에 배치되었습니다.";
  const targetUrl = resolveTargetUrlForPush(after.targetUrl);
  const userRef = db.doc(`users/${uid}`);

  let badgeN = 1;
  try {
    await userRef.set({appBadgeCount: FieldValue.increment(1)}, {merge: true});
    const badgeSnap = await userRef.get();
    badgeN = Math.min(
      99,
      Math.max(1, Number(badgeSnap.exists ? badgeSnap.get("appBadgeCount") || 1 : 1))
    );
  } catch (e) {
    console.error("[notifyLayoutSeatAssigned] badge increment failed", uid, e);
  }

  try {
    await messaging.send({
      token,
      notification: {title, body},
      data: {
        title,
        body,
        targetUrl,
        appBadgeCount: String(badgeN)
      },
      webpush: {
        fcmOptions: {link: targetUrl}
      }
    });
    await change.after.ref.set({fcmSeatNotifyDedupKey: dedupKey}, {merge: true});
  } catch (err) {
    const code = String(err?.code || "");
    console.error("[notifyLayoutSeatAssigned] FCM send failed", uid, code, err?.message || err);
    try {
      await userRef.set({appBadgeCount: FieldValue.increment(-1)}, {merge: true});
    } catch (_) {}
    if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
      await db.doc(`users/${uid}`).set({fcmToken: ""}, {merge: true});
      await change.after.ref.set({fcmSeatNotifyDedupKey: dedupKey}, {merge: true});
      return;
    }
    throw err;
  }
});
