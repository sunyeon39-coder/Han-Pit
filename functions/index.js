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
  const u = String(raw || "").trim() || "./global-layout.html";
  const origin = String(process.env.APP_ORIGIN || "").trim();
  if (!origin) return u;
  try {
    const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
    return new URL(u, `${base}/`).href;
  } catch (_) {
    return u;
  }
}

/**
 * layout_notifications/{uid} 문서 하나에 대해 dedup 체크 후 실제로 FCM을 보낸다.
 * onDocumentWritten 트리거(즉시 발송 가능한 경우)와 sendDueLayoutSeatNotifications
 * 스케줄러(notifyAt 지연 발송) 양쪽에서 공유한다.
 */
async function sendSeatAssignedNotificationIfDue(uid, notifyRef, after) {
  if (String(after.type || "").trim() !== "seat_assigned") return;
  if (after.acknowledged === true) return;

  const dedupKey = buildDedupKey(uid, after);
  const notifyTag = buildSeatNotifyTag(uid);
  const createdMs = toMillis(after.createdAt);
  const userRef = db.doc(`users/${uid}`);

  if (createdMs > 0 && Date.now() - createdMs > STALE_SEAT_NOTIFY_MAX_AGE_MS) {
    try {
      // acknowledged:true 로 같이 표시해 sendDueLayoutSeatNotifications 의
      // acknowledged==false 필터에서 빠지게 한다 — 안 그러면 아무도 안 연
      // 오래된 알림이 매 분 스윕 쿼리에 영원히 다시 걸려 쌓이고, 그러다 보면
      // limit(SEAT_NOTIFY_SWEEP_LIMIT) 때문에 정작 방금 도래한 새 알림이
      // 뒤로 밀려 못 보내지는 상황까지 생길 수 있다.
      await notifyRef.set(
        {fcmSeatNotifyDedupKey: dedupKey, fcmSeatNotifySending: FieldValue.delete(), acknowledged: true},
        {merge: true}
      );
    } catch (e) {
      console.error("[notifyLayoutSeatAssigned] stale notify mark failed", uid, e);
    }
    console.info("[notifyLayoutSeatAssigned] skip stale FCM", uid, createdMs);
    return;
  }

  // notifyAt(교대 공개 시점, REVEAL) 이 아직 안 지났으면 여기서는 보내지 않는다 —
  // sendDueLayoutSeatNotifications 스케줄러가 그 시점 이후에 다시 훑어서 보낸다.
  // notifyAt 이 없는(예전/다른 경로) 문서는 createdAt 기준으로 즉시 발송(기존 동작 유지).
  const notifyAtMs = toMillis(after.notifyAt) || createdMs;
  if (notifyAtMs > Date.now()) {
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

    const uid = String(event.params.uid || "").trim();
    if (!uid) return;

    await sendSeatAssignedNotificationIfDue(uid, change.after.ref, after);
  }
);

const SEAT_NOTIFY_SWEEP_LIMIT = 200;

/**
 * notifyAt(교대 공개 시점, REVEAL) 이 지났지만 아직 못 보낸 배치 알림을 1분마다 훑어 발송한다.
 * notifyLayoutSeatAssigned 는 문서가 "쓰여질 때"만 실행되므로, notifyAt 이 미래인 채로 쓰여진
 * 문서는(교대 5분 전 지연) 그 시점에 별도 쓰기가 없는 한 그 트리거만으로는 다시 실행되지 않는다.
 */
exports.sendDueLayoutSeatNotifications = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3"
  },
  async () => {
    const now = Date.now();
    let snap;
    try {
      snap = await db
        .collection("layout_notifications")
        .where("type", "==", "seat_assigned")
        .where("acknowledged", "==", false)
        .where("notifyAt", "<=", now)
        .limit(SEAT_NOTIFY_SWEEP_LIMIT)
        .get();
    } catch (e) {
      console.error("[sendDueLayoutSeatNotifications] query failed", e);
      return;
    }
    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      const uid = docSnap.id;
      try {
        await sendSeatAssignedNotificationIfDue(uid, docSnap.ref, docSnap.data() || {});
      } catch (e) {
        console.error("[sendDueLayoutSeatNotifications] failed", uid, e);
      }
    }
    console.info("[sendDueLayoutSeatNotifications] processed", snap.size);
  }
);

/* =====================================================================
 * 교대(스왑) 확정 대기 — global_seats.incomingPerson 이 확정된 지 10분(SEAT_SWAP_SETTLE_MS)
 * 지나면 실제로 교체를 마무리한다. 클라이언트(assignSelectedWaitingToSeat)는 좌석이 이미
 * 점유돼 있으면 실제 person 은 안 건드리고 incomingPerson/incomingAt 으로만 "예약"해 둔다
 * (0~10분 사이에 문제 있으면 더블클릭으로 취소 — cancelIncomingSeatSwap). 아무 조치가 없으면
 * 이 스케줄러가 1분마다 훑어서, 10분이 지난 예약 건을 실제 occupant 교체로 확정하고 기존
 * occupant를 대기열로 돌려보낸다.
 * ===================================================================== */
const SEAT_SWAP_SETTLE_MS = 10 * 60 * 1000;
const INCOMING_SWAP_FINALIZE_LIMIT = 100;

/**
 * uid 없는(계정 없이 수동 추가된) 사람을 위한 대기 문서 id — 이름 기반으로 결정적이어야
 * 한다. 매번 랜덤 id를 쓰면 같은 사람이 배치→교체를 반복할 때마다 예전 대기 문서가
 * 안 지워진 채 계속 쌓여, 실제로는 이미 다른 자리에 앉아 있는데도 대기 목록에 유령처럼
 * 계속 남아 보이는 원인이 됐다.
 */
function manualWaitingIdForName(name = "") {
  const safe = String(name || "")
    .trim()
    .replace(/[/\s]+/g, "_")
    .slice(0, 120);
  return `w_manual_${safe || "unnamed"}`;
}

/** 이 사람이 이 좌석 말고 다른 좌석에도 이미 앉아 있는지 — 대기로 되돌릴지 판단용 */
async function personHasOtherOccupiedSeat(tournamentId, excludeSeatPath, person) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || "").trim();
  if (!uid && !email && !name) return false;

  let snap;
  try {
    snap = await db
      .collection(`tournaments/${tournamentId}/global_seats`)
      .where("status", "==", "occupied")
      .get();
  } catch (e) {
    console.warn("[finalizeIncomingSeatSwaps] personHasOtherOccupiedSeat query failed", e);
    return false;
  }
  return snap.docs.some((d) => {
    if (d.ref.path === excludeSeatPath) return false;
    const data = d.data() || {};
    const dUid = String(data.personUid || "").trim();
    const dEmail = String(data.personEmail || "").trim().toLowerCase();
    const dName = String(data.person || "").trim();
    if (uid && dUid) return dUid === uid;
    if (email && dEmail) return dEmail === email;
    return !uid && !dUid && !!name && dName === name;
  });
}

async function finalizeOneIncomingSwap(seatDocSnap) {
  const seatRef = seatDocSnap.ref;
  const tournamentRef = seatRef.parent.parent;
  const tournamentId = tournamentRef ? tournamentRef.id : "";
  if (!tournamentId) return;

  // 트랜잭션 전에 "다른 좌석에도 있는지"부터 확인(트랜잭션 안에서는 쿼리 불가) — 약간의
  // 레이스는 감수한다(대기 목록 쪽 기존 heal 로직들과 동일한 전제).
  const data = seatDocSnap.data() || {};
  const prevName = String(data.person || "").trim();
  const prevUid = String(data.personUid || "").trim();
  const prevEmail = String(data.personEmail || "").trim();
  const prevHasOtherSeat =
    prevName && prevName !== "비어있음"
      ? await personHasOtherOccupiedSeat(tournamentId, seatRef.path, {
          uid: prevUid,
          email: prevEmail,
          name: prevName
        })
      : false;

  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(seatRef);
    if (!freshSnap.exists) return;
    const fresh = freshSnap.data() || {};
    const incomingName = String(fresh.incomingPerson || "").trim();
    if (!incomingName) return; // 이미 취소됐거나 다른 실행에서 처리됨
    const incomingAtMs = toMillis(fresh.incomingAt);
    if (!incomingAtMs || Date.now() - incomingAtMs < SEAT_SWAP_SETTLE_MS) return; // 레이스 방지

    const incomingUid = String(fresh.incomingPersonUid || "").trim();
    const incomingEmail = String(fresh.incomingPersonEmail || "").trim();
    const now = Date.now();

    // 클라이언트(seat-history.js)와 동일한 형태로 "교체" 이력을 남긴다 — 배치 이력 보기에
    // 스왑이 빠지지 않게.
    const seatHistory = Array.isArray(fresh.seatHistory) ? fresh.seatHistory.filter(Boolean) : [];
    if (prevName && prevName !== "비어있음") {
      seatHistory.push({
        person: prevName,
        personUid: prevUid,
        personEmail: prevEmail,
        seatedAt: Number(fresh.seatedAt) || now,
        leftAt: now,
        reason: "replace"
      });
    }
    const cappedHistory = seatHistory.length <= 40 ? seatHistory : seatHistory.slice(seatHistory.length - 40);

    tx.set(
      seatRef,
      {
        person: incomingName,
        personUid: incomingUid,
        personEmail: incomingEmail,
        // 실제로 자리를 넘겨받는 지금(finalize 시점)부터 새로 시작 — incomingAt(배치확인
        // 누른 시점)을 쓰면 그 10분 동안 실제로는 기존 점유자가 앉아 있었는데도 새
        // 사람의 착석 시간이 이미 10분 지난 것처럼 보였다.
        seatedAt: now,
        status: "occupied",
        incomingPerson: FieldValue.delete(),
        incomingPersonUid: FieldValue.delete(),
        incomingPersonEmail: FieldValue.delete(),
        incomingAt: FieldValue.delete(),
        seatHistory: cappedHistory,
        updatedAt: now
      },
      {merge: true}
    );

    if (incomingUid) {
      tx.set(
        db.doc(`dealer_attendance/${tournamentId}__${incomingUid}`),
        {
          uid: incomingUid,
          email: incomingEmail,
          name: incomingName,
          tournamentId,
          status: "assigned",
          statusChangedAt: now,
          updatedAt: now
        },
        {merge: true}
      );
    }

    if (prevName && prevName !== "비어있음") {
      if (!prevHasOtherSeat) {
        const waitingDocId = prevUid ? `w_${prevUid}` : manualWaitingIdForName(prevName);
        tx.set(
          db.doc(`tournaments/${tournamentId}/global_waiting/${waitingDocId}`),
          {
            id: waitingDocId,
            uid: prevUid,
            email: prevEmail,
            name: prevName,
            tournamentId,
            joinedAt: now,
            createdAt: now,
            source: "seat_swap_finalized"
          },
          {merge: true}
        );
      }

      if (prevUid) {
        tx.set(
          db.doc(`dealer_attendance/${tournamentId}__${prevUid}`),
          {
            uid: prevUid,
            email: prevEmail,
            name: prevName,
            tournamentId,
            status: prevHasOtherSeat ? "assigned" : "waiting",
            statusChangedAt: now,
            updatedAt: now
          },
          {merge: true}
        );

        if (!prevHasOtherSeat) {
          tx.set(
            db.doc(`layout_notifications/${prevUid}`),
            {type: "seat_cleared", acknowledged: true, updatedAt: now},
            {merge: true}
          );
        }
      }
    }
  });
}

exports.finalizeIncomingSeatSwaps = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3"
  },
  async () => {
    const cutoff = Date.now() - SEAT_SWAP_SETTLE_MS;
    let snap;
    try {
      snap = await db
        .collectionGroup("global_seats")
        .where("incomingAt", "<=", cutoff)
        .limit(INCOMING_SWAP_FINALIZE_LIMIT)
        .get();
    } catch (e) {
      console.error("[finalizeIncomingSeatSwaps] query failed", e);
      return;
    }
    if (snap.empty) return;

    for (const docSnap of snap.docs) {
      try {
        await finalizeOneIncomingSwap(docSnap);
      } catch (e) {
        console.error("[finalizeIncomingSeatSwaps] failed", docSnap.ref.path, e);
      }
    }
    console.info("[finalizeIncomingSeatSwaps] processed", snap.size);
  }
);

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
