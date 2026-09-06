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
const {getFirestore, FieldValue, FieldPath} = require("firebase-admin/firestore");
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
  const seatId = String(after.seatId || "").trim();
  return `${uid}|${createdMs}|${seatId}`;
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

exports.notifyLayoutSeatAssigned = onDocumentWritten(
  {
    document: "layout_notifications/{uid}",
    region: "asia-northeast3",
    minInstances: 1
  },
  async (event) => {
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
  const userRef = db.doc(`users/${uid}`);

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

  const userSnapPromise = userRef.get();
  let shouldSend = false;
  try {
    shouldSend = await db.runTransaction(async (tx) => {
      const snap = await tx.get(notifyRef);
      if (!snap.exists) return false;
      const cur = snap.data() || {};
      if (String(cur.fcmSeatNotifyDedupKey || "") === dedupKey) return false;
      if (String(cur.fcmSeatNotifySending || "") === dedupKey) return false;
      // 연속 배치(빠르게 다시 배정)로 이 트리거가 처리되는 사이 문서가 이미 더 최신
      // createdAt(다음 배치)으로 덮어써졌다면, 이 이벤트는 지나간 배치다 — 그대로 보내면
      // "방금 온 알림"이 최신 배치가 아니라 한 단계 전 배치를 가리키는 것처럼 보인다.
      // 최신 배치는 자신의 트리거 이벤트에서 별도로 알림을 보내므로 여기선 건너뛴다.
      const curCreatedMs = toMillis(cur.createdAt);
      if (curCreatedMs > createdMs) {
        console.info("[notifyLayoutSeatAssigned] skip superseded FCM", uid, createdMs, "-> latest", curCreatedMs);
        return false;
      }
      tx.set(notifyRef, {fcmSeatNotifySending: dedupKey}, {merge: true});
      return true;
    });
  } catch (e) {
    console.error("[notifyLayoutSeatAssigned] dedup transaction failed", uid, e);
    return;
  }
  if (!shouldSend) return;

  const userSnap = await userSnapPromise;
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

  void userRef.set({appBadgeCount: FieldValue.increment(1)}, {merge: true}).catch((e) => {
    console.error("[notifyLayoutSeatAssigned] badge increment failed", uid, e);
  });

  try {
    // 웹: notification 페이로드 + SW showNotification 이 겹치면 모바일에서 알림이 2개 뜸 → data-only
    await messaging.send({
      token,
      data: {
        title,
        body,
        targetUrl,
        appBadgeCount: "1",
        dedupKey,
        notifyTag,
        uid
      },
      android: {priority: "high"},
      apns: {
        headers: {"apns-priority": "10"},
        payload: {aps: {contentAvailable: true}}
      },
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
    void userRef.set({appBadgeCount: FieldValue.increment(-1)}, {merge: true}).catch(() => {});
    if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
      await userRef.set({fcmToken: ""}, {merge: true});
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

/* =====================================================================
 * 좌석 상태 표시(비상 / Break) — global_seats.alertKind 가 켜지면
 * 그 대회를 관리하는 admin/운영자 전원에게 백그라운드 FCM 전송.
 * (foreground 깜박임/소리는 클라이언트가 이미 처리 — 여기는 잠금화면·앱 종료 대비)
 * ===================================================================== */
const SEAT_ALERT_MAX_AGE_MS = 5 * 60 * 1000;

function normAlertKind(data = {}) {
  const k = String(data && data.alertKind || "").trim();
  if (k === "emergency" || k === "break") return k;
  return data && data.alertActive === true ? "emergency" : "";
}

/** 이 대회를 조작할 수 있는 사용자 uid 집합 (firestore.rules isAdmin() 과 동일 기준) */
async function collectTournamentAdminUids(tournamentId) {
  const tid = String(tournamentId || "").trim();
  const uids = new Set();
  if (!tid) return uids;
  const queries = [
    db.collection("users").where("opsTournamentIds", "array-contains", tid),
    db.collection("users").where(new FieldPath("allowedEvents", tid), "==", true),
    db.collection("users").where("role", "==", "admin")
  ];
  const results = await Promise.allSettled(queries.map((q) => q.get()));
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn("[notifyGlobalSeatAlert] admin query failed", i, r.reason && r.reason.message);
      return;
    }
    r.value.forEach((d) => uids.add(d.id));
  });
  return uids;
}

exports.notifyGlobalSeatAlert = onDocumentWritten(
  {
    document: "tournaments/{tournamentId}/global_seats/{seatDocId}",
    region: "asia-northeast3"
  },
  async (event) => {
    const change = event.data;
    if (!change || !change.after || !change.after.exists) return;

    const after = change.after.data() || {};
    const before = change.before && change.before.exists ? change.before.data() || {} : {};

    const kind = normAlertKind(after);
    if (!kind) return;                       // 꺼짐 / 원래 안 켜짐
    if (kind === normAlertKind(before)) return; // 좌표·타이머 등 무관한 쓰기

    const alertAtMs = toMillis(after.alertAt);
    if (alertAtMs && Date.now() - alertAtMs > SEAT_ALERT_MAX_AGE_MS) return; // 늦은 트리거·재시도

    const pushKey = `${kind}|${alertAtMs}`;
    if (String(after.alertPushKey || "") === pushKey) return;

    // 중복 전송 방지 — 이 pushKey 를 먼저 문서에 claim
    let claimed = false;
    try {
      claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(change.after.ref);
        if (!snap.exists) return false;
        const cur = snap.data() || {};
        if (normAlertKind(cur) !== kind) return false;
        if (String(cur.alertPushKey || "") === pushKey) return false;
        tx.set(change.after.ref, {alertPushKey: pushKey}, {merge: true});
        return true;
      });
    } catch (e) {
      console.error("[notifyGlobalSeatAlert] claim tx failed", e);
      return;
    }
    if (!claimed) return;

    const tid = String(event.params.tournamentId || "").trim();
    const byUid = String(after.alertBy || "").trim();

    const adminUids = await collectTournamentAdminUids(tid);
    const targets = [...adminUids].filter((u) => u && u !== byUid);
    if (!targets.length) return;

    const kindLabel = kind === "emergency" ? "비상" : "Break";
    const seatLabel = String(after.label || after.no || after.seatId || change.after.id || "").trim();
    const person = String(after.person || "").trim();
    const detail = [seatLabel ? `Seat ${seatLabel}` : "", person && person !== "비어있음" ? person : ""]
      .filter(Boolean)
      .join(" · ");
    const title = `Han Pit · ${kindLabel}`;
    const body = `${detail || "좌석"} — ${kindLabel} 표시`;
    const targetUrl = resolveTargetUrlForPush(
      `./global-layout.html?tournamentId=${encodeURIComponent(tid)}`
    );
    const notifyTag = `hanpit-seatalert-${tid}-${String(after.seatId || change.after.id || "").trim()}`;

    const userSnaps = await db.getAll(...targets.map((u) => db.doc(`users/${u}`)));
    const sends = [];
    for (const snap of userSnaps) {
      if (!snap.exists) continue;
      const uid = snap.id;
      const token = String(snap.get("fcmToken") || "").trim();
      if (!token) continue;

      void db
        .doc(`users/${uid}`)
        .set({appBadgeCount: FieldValue.increment(1)}, {merge: true})
        .catch(() => {});

      sends.push(
        messaging
          .send({
            token,
            data: {
              title,
              body,
              targetUrl,
              appBadgeCount: "1",
              notifyTag,
              uid,
              seatAlert: "1",
              alertKind: kind
            },
            android: {priority: "high"},
            apns: {
              headers: {"apns-priority": "10"},
              payload: {aps: {contentAvailable: true}}
            },
            webpush: {
              fcmOptions: {link: targetUrl},
              headers: {Urgency: "high", TTL: "3600"}
            }
          })
          .catch((err) => {
            const code = String(err && err.code || "");
            void db
              .doc(`users/${uid}`)
              .set({appBadgeCount: FieldValue.increment(-1)}, {merge: true})
              .catch(() => {});
            if (
              code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered"
            ) {
              return db.doc(`users/${uid}`).set({fcmToken: ""}, {merge: true}).catch(() => {});
            }
            console.error("[notifyGlobalSeatAlert] send failed", uid, code, err && err.message);
          })
      );
    }
    await Promise.allSettled(sends);
    console.info("[notifyGlobalSeatAlert]", tid, kind, "targets", targets.length, "sent", sends.length);
  }
);

const ATTENDANCE_LOGS = "dealer_attendance_logs";
const LOG_RETENTION_DAYS = 45;
const LOG_MAX_TOTAL = 80000;
const LOG_MAX_PER_TOURNAMENT = 30000;
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

/** 매일 새벽 — 45일 초과·대회당 30000건·전체 80000건 초과 로그 정리 */
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
