/**
 * 출퇴근 시각 서버 검증 (근무 시간·인건비 조작 방지).
 *
 * 근무자(운영 권한 없는 계정)는 자기 dealer_attendance 문서·출퇴근 로그·대기 행을 클라이언트에서
 * 직접 쓴다. Firestore rules 로는 "미래 시각 금지"만 걸 수 있었고 과거로 당기는 조작(출근 시각을
 * 6시간 전으로 쓰기, 로그 newCheckedInAt 조작, 대기 행 joinedAt 조작 후 heal 경로로 복사,
 * totalBreakMs 줄이기)은 막을 수 없었다 — 정상 흐름도 과거 값(이전 출근 시각 유지, 대기 진입 시각)을
 * 쓰기 때문에 규칙으로 일괄 금지하면 출근이 깨진다.
 *
 * 그래서 쓰기 직후 트리거(auth context 포함)가 "누가 썼는지"를 보고, 근무자 본인이 쓴 경우에만
 * 시각 필드를 서버 시각 기준으로 검증해 어긋나면 되돌린다:
 *  - 새 값이 서버 시각 - TOLERANCE 이후면 통과 (방금 일어난 일)
 *  - 바뀌지 않았으면 통과 (이전에 검증된 값 유지)
 *  - 그 외 과거 값은 "서버가 이미 검증한 기준값"(대기 행 진입 시각 / 출근 문서 시각)과 같을 때만 통과
 *  - 아니면 이전 값(없으면 서버 시각)으로 되돌리고 lastServerTimeCorrection 에 원래 값을 남긴다
 * 운영자·서버(Admin SDK) 쓰기는 손대지 않는다 — 운영자의 출퇴근 수정(adjust_*)은 정당한 과거 값이다.
 * 쓴 사람을 확인할 수 없는 이벤트(authId 없음)도 손대지 않는다(잘못 되돌리는 사고 방지).
 */
const {onDocumentWrittenWithAuthContext, onDocumentCreatedWithAuthContext} = require("firebase-functions/v2/firestore");
const {getFirestore} = require("firebase-admin/firestore");
const {getAuth} = require("firebase-admin/auth");

/** 오프라인 큐·네트워크 지연으로 늦게 도착한 정상 쓰기를 허용하는 폭 */
const TOLERANCE_MS = 10 * 60 * 1000;
/** 기준값 문서가 방금 바뀌었으면(검증 트리거가 아직 안 돌았을 수 있음) 잠깐 기다렸다 다시 읽는다 */
const ANCHOR_SETTLE_MS = 30 * 1000;
const ANCHOR_RECHECK_DELAY_MS = 6000;
const ADMIN_CACHE_MS = 5 * 60 * 1000;

const ACTIVE = new Set(["waiting", "checked_in", "assigned", "break"]);
const WAITING_TIME_FIELDS = ["joinedAt", "addedAt", "createdAt"];

function toMs(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const isActive = (s) => ACTIVE.has(String(s || "").trim());

/* ---------------- 순수 검증 함수 (테스트 대상) ---------------- */

/**
 * dealer_attendance 근무자 쓰기 검증. anchors = 서버가 신뢰하는 과거 시각 집합(대기 행 진입 시각 등).
 * 반환: { fieldName: 서버가 쓸 값 } (빈 객체면 통과)
 */
function validateAttendanceWrite(before = {}, after = {}, serverMs, anchors = new Set()) {
  const out = {};
  const T = Number(serverMs);
  const enteringActive = isActive(after.status) && !isActive(before.status);

  const a = toMs(after.checkedInAt);
  const b = toMs(before.checkedInAt);
  if (a > 0 && a !== b && a < T - TOLERANCE_MS && !anchors.has(a)) {
    // 이미 근무 중이던 사람이 출근 시각만 당긴 경우 → 원래 값으로, 새 출근이면 → 지금
    out.checkedInAt = !enteringActive && b > 0 && isActive(before.status) ? b : T;
  }

  // 휴식 중에 휴식 시작 시각을 늦춰 휴식 시간을 줄이는 것 금지
  if (
    String(before.status) === "break" &&
    String(after.status) === "break" &&
    toMs(before.breakStartedAt) > 0 &&
    toMs(after.breakStartedAt) !== toMs(before.breakStartedAt)
  ) {
    out.breakStartedAt = toMs(before.breakStartedAt);
  }

  // 누적 휴식은 새 출근(비활성 → 활성) 때만 0 으로 줄일 수 있다. 휴식 종료 시 더해야 할 만큼은 서버가 계산.
  if (!enteringActive && "totalBreakMs" in after) {
    const y = Number(before.totalBreakMs || 0) || 0;
    const x = Number(after.totalBreakMs || 0) || 0;
    const bsa = toMs(before.breakStartedAt);
    const endedBreak = String(before.status) === "break" && String(after.status) !== "break" && bsa > 0;
    const expected = endedBreak ? y + Math.max(0, T - bsa) : y;
    if (x < expected - TOLERANCE_MS || (!endedBreak && x < y)) {
      out.totalBreakMs = expected;
    }
  }
  return out;
}

/** global_waiting 근무자 쓰기 검증 — 대기 진입 시각을 과거로 당기기 금지 */
function validateWaitingWrite(before = {}, after = {}, serverMs) {
  const out = {};
  const T = Number(serverMs);
  for (const f of WAITING_TIME_FIELDS) {
    const a = toMs(after[f]);
    const b = toMs(before[f]);
    if (a > 0 && a !== b && a < T - TOLERANCE_MS) out[f] = b > 0 ? b : T;
  }
  return out;
}

/** dealer_attendance_logs 근무자 생성 검증. anchors = 출근 문서의(검증된) 출근 시각 등 */
function validateLogCreate(log = {}, serverMs, anchors = new Set()) {
  const out = {};
  const T = Number(serverMs);
  const c = toMs(log.createdAt);
  if (c > 0 && c < T - TOLERANCE_MS) out.createdAt = T;
  const n = toMs(log.newCheckedInAt);
  if (n > 0 && n < T - TOLERANCE_MS && !anchors.has(n)) {
    const fallback = [...anchors].filter((v) => v > 0).sort((p, q) => q - p)[0];
    out.newCheckedInAt = fallback || T;
  }
  return out;
}

/* ---------------- 트리거 ---------------- */

const adminCache = new Map();
async function isOpsAdminUid(uid, systemAdminEmails) {
  const cached = adminCache.get(uid);
  if (cached && Date.now() - cached.at < ADMIN_CACHE_MS) return cached.value;
  let value = false;
  try {
    const snap = await getFirestore().doc(`users/${uid}`).get();
    const d = snap.exists ? snap.data() || {} : {};
    const allowed = d.allowedEvents && typeof d.allowedEvents === "object" ? Object.keys(d.allowedEvents).length : 0;
    const ops = Array.isArray(d.opsTournamentIds) ? d.opsTournamentIds.length : 0;
    value = String(d.role || "user") === "admin" || allowed > 0 || ops > 0;
    if (!value) {
      const rec = await getAuth().getUser(uid);
      const email = String(rec.email || "").trim().toLowerCase();
      value = systemAdminEmails.map((e) => e.toLowerCase()).includes(email);
    }
  } catch (e) {
    // 판단 불가 → 운영자로 취급해 손대지 않는다(정당한 수정을 되돌리는 쪽이 더 위험)
    console.warn("[attendanceGuard] admin check failed", uid, e && e.code);
    value = true;
  }
  adminCache.set(uid, {value, at: Date.now()});
  return value;
}

/** 근무자 본인 쓰기인지 — authId 가 있고 운영자가 아닐 때만 true */
let authSampleLogged = 0;
async function isDealerSelfWrite(event, systemAdminEmails) {
  const type = String(event.authType || "");
  const uid = String(event.authId || "").trim();
  // 서버(Functions 등)의 쓰기는 authId 가 서비스 계정 이메일로 온다 — 사용자 조회 없이 건너뛴다
  if (!uid || uid.includes("@") || type === "service_account" || type === "system") return null;
  const admin = await isOpsAdminUid(uid, systemAdminEmails);
  if (authSampleLogged < 30) {
    authSampleLogged += 1;
    console.info("[attendanceGuard] auth sample", type || "(none)", admin ? "ops" : "dealer");
  }
  return admin ? null : uid;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 방금 바뀐 문서면 검증 트리거가 돌 시간을 준 뒤 다시 읽는다 */
async function readSettled(ref) {
  let snap = await ref.get();
  const updated = snap.updateTime ? snap.updateTime.toMillis() : 0;
  if (updated && Date.now() - updated < ANCHOR_SETTLE_MS) {
    await sleep(ANCHOR_RECHECK_DELAY_MS);
    snap = await ref.get();
  }
  return snap;
}

function correctionRecord(uid, serverMs, client, server) {
  const fields = {};
  for (const k of Object.keys(server)) fields[k] = {client: client[k] ?? null, server: server[k]};
  return {at: serverMs, by: uid, fields};
}

function buildAttendanceGuards({region, systemAdminEmails}) {
  const db = () => getFirestore();

  const guardDealerAttendance = onDocumentWrittenWithAuthContext(
    {document: "dealer_attendance/{docId}", region},
    async (event) => {
      const change = event.data;
      if (!change || !change.after || !change.after.exists) return;
      const uid = await isDealerSelfWrite(event, systemAdminEmails);
      if (!uid) return;
      const T = Date.parse(event.time) || Date.now();
      const before = change.before && change.before.exists ? change.before.data() || {} : {};
      const after = change.after.data() || {};
      const tid = String(after.tournamentId || String(event.params.docId).split("__")[0] || "").trim();

      let fix = validateAttendanceWrite(before, after, T);
      if (fix.checkedInAt !== undefined && tid) {
        // 과거 출근 시각 — 본인 대기 행의 (검증된) 진입 시각과 같으면 정상 heal/복구 경로다
        const anchors = new Set();
        const q = await db()
          .collection(`tournaments/${tid}/global_waiting`)
          .where("uid", "==", uid)
          .get();
        for (const d of q.docs) {
          const settled = await readSettled(d.ref);
          const w = settled.exists ? settled.data() || {} : {};
          for (const f of [...WAITING_TIME_FIELDS, "joinedAtServer", "carryStartedAt"]) {
            const v = toMs(w[f]);
            if (v > 0) anchors.add(v);
          }
        }
        fix = validateAttendanceWrite(before, after, T, anchors);
      }
      if (!Object.keys(fix).length) return;

      console.warn("[attendanceGuard] dealer_attendance corrected", event.params.docId, fix);
      await change.after.ref.set(
        {...fix, lastServerTimeCorrection: correctionRecord(uid, T, after, fix)},
        {merge: true}
      );
    }
  );

  const guardGlobalWaitingTimes = onDocumentWrittenWithAuthContext(
    {document: "tournaments/{tournamentId}/global_waiting/{entryId}", region},
    async (event) => {
      const change = event.data;
      if (!change || !change.after || !change.after.exists) return;
      const uid = await isDealerSelfWrite(event, systemAdminEmails);
      if (!uid) return;
      const T = Date.parse(event.time) || Date.now();
      const before = change.before && change.before.exists ? change.before.data() || {} : {};
      const after = change.after.data() || {};
      const fix = validateWaitingWrite(before, after, T);
      if (!Object.keys(fix).length) return;
      console.warn("[attendanceGuard] global_waiting corrected", event.params.entryId, fix);
      await change.after.ref.set(
        {...fix, lastServerTimeCorrection: correctionRecord(uid, T, after, fix)},
        {merge: true}
      );
    }
  );

  const guardAttendanceLogCreate = onDocumentCreatedWithAuthContext(
    {document: "dealer_attendance_logs/{logId}", region},
    async (event) => {
      const snap = event.data;
      if (!snap || !snap.exists) return;
      const uid = await isDealerSelfWrite(event, systemAdminEmails);
      if (!uid) return;
      const T = Date.parse(event.time) || Date.now();
      const log = snap.data() || {};

      let fix = validateLogCreate(log, T);
      if (fix.newCheckedInAt !== undefined) {
        // 과거 newCheckedInAt — 출근 문서의 (검증된) 출근 시각과 같으면 정상(근무 중 상태 변경 로그)
        const tid = String(log.tournamentId || "").trim();
        const anchors = new Set();
        if (tid) {
          const att = await readSettled(db().doc(`dealer_attendance/${tid}__${uid}`));
          const v = att.exists ? toMs((att.data() || {}).checkedInAt) : 0;
          if (v > 0) anchors.add(v);
        }
        fix = validateLogCreate(log, T, anchors);
      }
      if (!Object.keys(fix).length) return;
      console.warn("[attendanceGuard] attendance log corrected", event.params.logId, fix);
      await snap.ref.set({...fix, serverTimeCorrection: correctionRecord(uid, T, log, fix)}, {merge: true});
    }
  );

  return {guardDealerAttendance, guardGlobalWaitingTimes, guardAttendanceLogCreate};
}

module.exports = {
  buildAttendanceGuards,
  validateAttendanceWrite,
  validateWaitingWrite,
  validateLogCreate,
  TOLERANCE_MS
};
