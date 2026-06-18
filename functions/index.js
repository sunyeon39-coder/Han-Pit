/**
 * layout_notifications/{uid} 에 seat_assigned 가 기록되면 users/{uid}.fcmToken 으로 FCM 전송.
 * (레이아웃 / 통합 배치도 / 동일 Firestore 경로를 쓰는 모든 배치 흐름 공통 처리)
 *
 * - OS 알림 tag: hanpit-seat-{uid} (사용자당 1개, 잠금 화면은 최신 배치로 갱신)
 * - createdAt 30분 초과 문서는 FCM 생략 (재시도·늦은 트리거만 차단)
 * - dedupKey 는 Cloud Function 내부 중복 전송 방지용
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
const {onSchedule} = require("firebase-functions/v2/scheduler");
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

function buildSeatNotifyTag(uid) {
  const u = String(uid || "").trim();
  return u ? `hanpit-seat-${u}` : "hanpit-seat";
}

const STALE_SEAT_NOTIFY_MAX_AGE_MS = 30 * 60 * 1000;

const PUSH_APP_TITLE = "Han Pit";

function cardIdFromEventInstanceId(value = "") {
  const id = String(value || "").trim();
  if (!id) return "";
  const parts = id.split("~");
  if (parts.length !== 3) return "";
  const cardId = String(parts[1] || "").trim();
  return cardId || "";
}

function resolveSeatPushCardLabel(after = {}) {
  const eventId = String(after.eventId || "").trim();
  let label = String(after.eventTitle || "").trim();
  if (label.includes("~")) {
    const fromTitle = cardIdFromEventInstanceId(label);
    if (fromTitle) return fromTitle;
  }
  const fromEventId = cardIdFromEventInstanceId(eventId);
  if (fromEventId) return fromEventId;
  if (label && label !== eventId) return label;
  return eventId;
}

function buildSeatAssignedPushBody(after = {}) {
  const eventTitle = resolveSeatPushCardLabel(after);
  const seatLabel = String(after.seatLabel || after.seatId || "").trim();
  if (eventTitle && seatLabel) {
    return `${eventTitle} / Seat ${seatLabel}`;
  }
  if (eventTitle) return `${eventTitle} / Seat`;
  if (seatLabel) return `Seat ${seatLabel}`;

  const msg = String(after.message || "").trim();
  if (msg) {
    const stripped = msg
      .replace(/\s*에 배치되었습니다\.?\s*$/u, "")
      .replace(/^배치\s*알림\s*[:：]?\s*/u, "")
      .trim();
    if (stripped && !/^Seat에 배치되었습니다\.?$/i.test(stripped)) {
      return stripped;
    }
  }
  return "좌석이 배치되었습니다.";
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
  const notifyTag = buildSeatNotifyTag(uid);
  const createdMs = toMillis(after.createdAt);
  const notifyRef = change.after.ref;

  if (createdMs > 0 && Date.now() - createdMs > STALE_SEAT_NOTIFY_MAX_AGE_MS) {
    try {
      await notifyRef.set(
        {fcmSeatNotifyDedupKey: dedupKey, fcmSeatNotifySending: FieldValue.delete()},
        {merge: true}
      );
    } catch (e) {
      console.error("[notifyLayoutSeatAssigned] stale notify mark failed", uid, e);
    }
    console.info("[notifyLayoutSeatAssigned] skip stale FCM", uid, createdMs);
    return;
  }
  let shouldSend = false;
  try {
    shouldSend = await db.runTransaction(async (tx) => {
      const snap = await tx.get(notifyRef);
      if (!snap.exists) return false;
      const cur = snap.data() || {};
      if (String(cur.fcmSeatNotifyDedupKey || "") === dedupKey) return false;
      if (String(cur.fcmSeatNotifySending || "") === dedupKey) return false;
      tx.set(notifyRef, {fcmSeatNotifySending: dedupKey}, {merge: true});
      return true;
    });
  } catch (e) {
    console.error("[notifyLayoutSeatAssigned] dedup transaction failed", uid, e);
    return;
  }
  if (!shouldSend) return;

  const userSnap = await db.doc(`users/${uid}`).get();
  const token = userSnap.exists ? String(userSnap.get("fcmToken") || "").trim() : "";
  if (!token) {
    await notifyRef.set(
      {fcmSeatNotifyDedupKey: dedupKey, fcmSeatNotifySending: FieldValue.delete()},
      {merge: true}
    );
    return;
  }

  const title = PUSH_APP_TITLE;
  const body = buildSeatAssignedPushBody(after);
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
    // 웹: notification 페이로드 + SW showNotification 이 겹치면 모바일에서 알림이 2개 뜸 → data-only
    await messaging.send({
      token,
      data: {
        title,
        body,
        targetUrl,
        appBadgeCount: String(badgeN),
        dedupKey,
        notifyTag,
        uid
      },
      android: {priority: "high"},
      webpush: {
        fcmOptions: {link: targetUrl},
        headers: {
          Urgency: "high",
          TTL: "86400"
        }
      }
    });
    await notifyRef.set(
      {fcmSeatNotifyDedupKey: dedupKey, fcmSeatNotifySending: FieldValue.delete()},
      {merge: true}
    );
  } catch (err) {
    const code = String(err?.code || "");
    console.error("[notifyLayoutSeatAssigned] FCM send failed", uid, code, err?.message || err);
    try {
      await userRef.set({appBadgeCount: FieldValue.increment(-1)}, {merge: true});
    } catch (_) {}
    if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
      await db.doc(`users/${uid}`).set({fcmToken: ""}, {merge: true});
      await notifyRef.set(
        {fcmSeatNotifyDedupKey: dedupKey, fcmSeatNotifySending: FieldValue.delete()},
        {merge: true}
      );
      return;
    }
    await notifyRef.set({fcmSeatNotifySending: FieldValue.delete()}, {merge: true});
    throw err;
  }
});

const ATTENDANCE_LOGS = "dealer_attendance_logs";
const LOG_RETENTION_DAYS = 14;
const LOG_MAX_TOTAL = 2000;
const LOG_MAX_PER_TOURNAMENT = 400;
const LOG_DELETE_BATCH = 400;

async function deleteLogQuery(queryRef, batchSize = LOG_DELETE_BATCH) {
  const snap = await queryRef.limit(batchSize).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

async function pruneLogsOlderThan(cutoffMs) {
  let deleted = 0;
  for (let round = 0; round < 30; round++) {
    const n = await deleteLogQuery(
      db.collection(ATTENDANCE_LOGS).where("createdAt", "<", cutoffMs)
    );
    if (!n) break;
    deleted += n;
  }
  return deleted;
}

async function pruneGlobalExcess() {
  const snap = await db
    .collection(ATTENDANCE_LOGS)
    .orderBy("createdAt", "desc")
    .limit(LOG_MAX_TOTAL + 1)
    .get();
  if (snap.size <= LOG_MAX_TOTAL) return 0;

  const threshold = toMillis(snap.docs[snap.docs.length - 1].data().createdAt);
  if (!threshold) return 0;

  let deleted = 0;
  for (let round = 0; round < 30; round++) {
    const n = await deleteLogQuery(
      db.collection(ATTENDANCE_LOGS).where("createdAt", "<=", threshold)
    );
    if (!n) break;
    deleted += n;
  }
  return deleted;
}

async function prunePerTournamentExcess() {
  const seed = await db
    .collection(ATTENDANCE_LOGS)
    .orderBy("createdAt", "desc")
    .limit(400)
    .get();
  const tids = new Set();
  seed.docs.forEach((d) => {
    const tid = String(d.data()?.tournamentId || "").trim();
    if (tid) tids.add(tid);
  });

  let deleted = 0;
  for (const tid of tids) {
    const snap = await db
      .collection(ATTENDANCE_LOGS)
      .where("tournamentId", "==", tid)
      .orderBy("createdAt", "desc")
      .limit(LOG_MAX_PER_TOURNAMENT + 1)
      .get();
    if (snap.size <= LOG_MAX_PER_TOURNAMENT) continue;

    const threshold = toMillis(snap.docs[snap.docs.length - 1].data().createdAt);
    if (!threshold) continue;

    for (let round = 0; round < 15; round++) {
      const n = await deleteLogQuery(
        db
          .collection(ATTENDANCE_LOGS)
          .where("tournamentId", "==", tid)
          .where("createdAt", "<=", threshold)
      );
      if (!n) break;
      deleted += n;
    }
  }
  return deleted;
}

/** 매일 새벽 — 14일 초과·대회당 400건·전체 2000건 초과 로그 정리 */
exports.pruneDealerAttendanceLogs = onSchedule(
  {
    schedule: "0 4 * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3"
  },
  async () => {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const byAge = await pruneLogsOlderThan(cutoff);
    const byTournament = await prunePerTournamentExcess();
    const byTotal = await pruneGlobalExcess();
    console.info("[pruneDealerAttendanceLogs]", {byAge, byTournament, byTotal});
  }
);
