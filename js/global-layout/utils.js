import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import { isFirestoreQuotaCoolingDown, noteFirestoreQuotaExceeded } from "../shared/firestore-quota-guard.js";
import { SEAT_SWAP_REVEAL_DELAY_MS, SEAT_SWAP_SETTLE_MS } from "../shared/seat-notification-push.js";

export { getIsAdmin, canManageTournament } from "../shared/auth-helpers.js";
export { escapeHtml } from "../shared/dom-utils.js";

export function seatCanvasDigitsOnly(label, no) {
  const l = String(label ?? "").trim();
  if (l) return l;
  const nStr = no != null && no !== "" ? String(no).trim() : "";
  if (nStr) return nStr;
  return "—";
}

/** 패널 Seat순: 화면 SEAT 뱃지(라벨·no) 숫자 인식 오름차순 */
export function compareSeatsByCanvasLabel(a = {}, b = {}) {
  const la = seatCanvasDigitsOnly(a.label, a.no);
  const lb = seatCanvasDigitsOnly(b.label, b.no);
  const cmp = la.localeCompare(lb, undefined, { numeric: true, sensitivity: "base" });
  if (cmp !== 0) return cmp;
  return (a.order ?? a.no ?? 0) - (b.order ?? b.no ?? 0);
}

export function isEmptyPerson(name = "") {
  const v = String(name || "").trim();
  return !v || v === "비어있음";
}

export function makeUid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

export function isValidSeatLabel(label = "") {
  const value = String(label || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(value);
}

export function isValidLayoutRouteIdPart(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/") && !value.includes("__");
}

export function looksLikeDisplayTitleNotId(id = "") {
  const value = String(id || "").trim();
  if (!value) return false;
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(value) && !/[A-Za-z0-9]/.test(value)) return true;
  return false;
}

export function buildGlobalSeatDocId(eventId = "", boxId = "", seatId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}__${String(seatId || "").trim()}`;
}

export function resolveSeatEventBox(seat = {}) {
  const eventId = String(seat?.currentEventId || seat?.mappedEventId || "").trim();
  const boxId = String(seat?.boxId || "").trim();
  return { eventId, boxId };
}

export function captureSeatShellSnapshot(seat = {}, seatData = {}) {
  const data = seatData && typeof seatData === "object" ? seatData : {};
  const hint = seat && typeof seat === "object" ? seat : {};
  const seatId = String(hint.seatId || data.seatId || "").trim();
  const label = String(hint.label ?? data.label ?? hint.no ?? data.no ?? seatId).trim();
  const order = Number(hint.order ?? data.order ?? hint.no ?? data.no ?? 0) || 0;

  return {
    seatId,
    label,
    no: Number(hint.no ?? data.no ?? order) || order,
    order,
    x: Number(hint.x ?? data.x ?? 0) || 0,
    y: Number(hint.y ?? data.y ?? 0) || 0,
    currentEventId: String(
      hint.currentEventId || hint.mappedEventId || data.currentEventId || data.mappedEventId || ""
    ).trim(),
    mappedEventId: String(hint.mappedEventId || data.mappedEventId || data.currentEventId || "").trim(),
    boxId: String(hint.boxId || data.boxId || "").trim(),
    tournamentId: String(hint.tournamentId || data.tournamentId || GL.tournamentId || "").trim()
  };
}

/** realtime __firestoreDocId 우선 — currentEventId만 있을 때 mappedEventId 불일치로 문서를 못 찾는 경우 방지 */
export function getGlobalSeatDocRef(seat = {}, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const sid = String(seat?.seatId || "").trim();
  if (!tid || !sid) return null;

  const cachedId = String(seat?.__firestoreDocId || "").trim();
  if (cachedId) {
    return doc(db, "tournaments", tid, "global_seats", cachedId);
  }

  const { eventId, boxId } = resolveSeatEventBox(seat);
  if (!eventId || !boxId) return null;

  return doc(db, "tournaments", tid, "global_seats", buildGlobalSeatDocId(eventId, boxId, sid));
}

/** 좌석 수정 직후 문서 ID가 바뀐 경우를 대비한 후보 ref 목록 */
export function getGlobalSeatDocRefs(seat = {}, tournamentId = "", fallbackPairs = []) {
  const tid = String(tournamentId || "").trim();
  const sid = String(seat?.seatId || "").trim();
  if (!tid || !sid) return [];

  const refs = [];
  const seen = new Set();
  const pushRef = (docId = "") => {
    const id = String(docId || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    refs.push(doc(db, "tournaments", tid, "global_seats", id));
  };

  const cachedId = String(seat?.__firestoreDocId || "").trim();
  if (cachedId) pushRef(cachedId);

  const { eventId, boxId } = resolveSeatEventBox(seat);
  if (eventId && boxId) {
    pushRef(buildGlobalSeatDocId(eventId, boxId, sid));
  }

  for (const pair of fallbackPairs || []) {
    const e = String(pair?.eventId || "").trim();
    const b = String(pair?.boxId || "").trim();
    if (!e || !b) continue;
    pushRef(buildGlobalSeatDocId(e, b, sid));
  }

  return refs;
}

/** undo/redo payload → global_seats 문서 ref (캐시 doc id 우선) */
export function resolveGlobalSeatDocRefForUndo(
  payload = {},
  tournamentId = "",
  seatHint = null
) {
  const tid = String(tournamentId || "").trim();
  const seatId = String(payload.targetSeatId || payload.seatId || seatHint?.seatId || "").trim();
  const seat =
    seatHint ||
    (seatId ? GL.globalSeats.find((s) => String(s.seatId || "").trim() === seatId) : null);

  const firestoreDocId = String(
    payload.firestoreDocId || seat?.__firestoreDocId || ""
  ).trim();
  if (tid && firestoreDocId) {
    return doc(db, "tournaments", tid, "global_seats", firestoreDocId);
  }

  if (seat && tid) {
    const ref = getGlobalSeatDocRef(seat, tid);
    if (ref) return ref;
  }

  const eventId = String(payload.eventId || "").trim();
  const boxId = String(payload.boxId || "").trim();
  if (tid && eventId && boxId && seatId) {
    return doc(db, "tournaments", tid, "global_seats", buildGlobalSeatDocId(eventId, boxId, seatId));
  }

  return null;
}

/** 동일 seatId 로 남은 중복 global_seats 문서 (이벤트 이동 시 고아 문서 정리) */
export async function listGlobalSeatDocRefsBySeatId(tournamentId = "", seatId = "") {
  const tid = String(tournamentId || "").trim();
  const sid = String(seatId || "").trim();
  if (!tid || !sid) return [];

  try {
    const qs = await getDocs(
      query(
        collection(db, "tournaments", tid, "global_seats"),
        where("seatId", "==", sid),
        limit(50)
      )
    );
    return qs.docs.map((d) => ({
      ref: d.ref,
      id: d.id,
      data: d.data() || {}
    }));
  } catch (err) {
    console.warn("listGlobalSeatDocRefsBySeatId error:", err?.code || err);
    return [];
  }
}

/** Firestore global_seats 문서 조회 — doc id 후보 + seatId 쿼리 */
export async function resolveGlobalSeatFirestoreDoc(
  seat = {},
  tournamentId = "",
  fallbackPairs = []
) {
  const tid = String(tournamentId || "").trim();
  const sid = String(seat?.seatId || "").trim();
  if (!tid || !sid) return null;

  const cachedId = String(seat?.__firestoreDocId || "").trim();
  if (cachedId) {
    const cachedRef = doc(db, "tournaments", tid, "global_seats", cachedId);
    try {
      const snap = await getDoc(cachedRef);
      if (snap.exists()) {
        return { ref: cachedRef, snap, data: snap.data() || {}, docId: snap.id };
      }
    } catch (err) {
      console.warn("resolveGlobalSeatFirestoreDoc cached getDoc:", err?.code || err);
    }
  }

  const refs = getGlobalSeatDocRefs(seat, tid, fallbackPairs);
  for (const ref of refs) {
    if (cachedId && String(ref.path || "").endsWith(`/${cachedId}`)) continue;
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) {
        return { ref, snap, data: snap.data() || {}, docId: snap.id };
      }
    } catch (err) {
      noteFirestoreQuotaExceeded(err);
      console.warn("resolveGlobalSeatFirestoreDoc getDoc:", err?.code || err);
    }
  }

  if (isFirestoreQuotaCoolingDown()) return null;

  try {
    const qs = await getDocs(
      query(
        collection(db, "tournaments", tid, "global_seats"),
        where("seatId", "==", sid),
        limit(20)
      )
    );
    if (!qs.empty) {
      const pick =
        qs.docs.find((d) => {
          const data = d.data() || {};
          const { eventId, boxId } = resolveSeatEventBox(seat);
          const e = String(data.currentEventId || data.mappedEventId || "").trim();
          const b = String(data.boxId || "").trim();
          return !eventId || !boxId || (e === eventId && b === boxId);
        }) || qs.docs[0];
      return {
        ref: pick.ref,
        snap: pick,
        data: pick.data() || {},
        docId: pick.id
      };
    }
  } catch (err) {
    console.warn("resolveGlobalSeatFirestoreDoc query:", err?.code || err);
  }

  return null;
}

/** 메모리에만 있는 좌석이면 Firestore 문서를 복구(merge) */
export async function ensureGlobalSeatFirestoreDoc(
  seat = {},
  tournamentId = "",
  fallbackPairs = []
) {
  const found = await resolveGlobalSeatFirestoreDoc(seat, tournamentId, fallbackPairs);
  if (found) return found;

  const tid = String(tournamentId || "").trim();
  const sid = String(seat?.seatId || "").trim();
  const { eventId, boxId } = resolveSeatEventBox(seat);
  if (!tid || !sid || !eventId || !boxId) return null;

  const docId = buildGlobalSeatDocId(eventId, boxId, sid);
  const ref = doc(db, "tournaments", tid, "global_seats", docId);
  const now = Date.now();
  const person = String(seat.person || "비어있음").trim();

  await setDoc(
    ref,
    {
      seatId: sid,
      label: String(seat.label ?? seat.no ?? sid).trim(),
      no: Number(seat.no || 0) || 0,
      order: Number(seat.order || 0) || 0,
      x: Number(seat.x || 0) || 0,
      y: Number(seat.y || 0) || 0,
      person,
      personUid: String(seat.personUid || "").trim(),
      personEmail: String(seat.personEmail || "").trim(),
      seatedAt: seat.seatedAt ?? null,
      status: isEmptyPerson(person) ? "empty" : "occupied",
      tournamentId: tid,
      mappedEventId: eventId,
      currentEventId: eventId,
      boxId,
      sourceLayoutDocId: getProjectionDocId(eventId, boxId),
      updatedAt: now,
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );

  const data = {
    seatId: sid,
    label: String(seat.label ?? seat.no ?? sid).trim(),
    currentEventId: eventId,
    mappedEventId: eventId,
    boxId
  };
  return { ref, snap: null, data, docId };
}

/** global_seats 문서 ID → eventId / boxId (eventId에 __ 없음 가정) */
export function parseGlobalSeatDocId(docId = "", seatId = "") {
  const id = String(docId || "").trim();
  const sid = String(seatId || "").trim();
  if (!id || !sid) return null;
  const suffix = `__${sid}`;
  if (!id.endsWith(suffix)) return null;
  const rest = id.slice(0, -suffix.length);
  const sep = rest.lastIndexOf("__");
  if (sep < 0) return null;
  const eventId = rest.slice(0, sep).trim();
  const boxId = rest.slice(sep + 2).trim();
  if (!eventId || !boxId) return null;
  return { eventId, boxId };
}

/** global_seats 문서 ID만으로 eventId / boxId / seatId 추출 */
export function parseGlobalSeatDocIdParts(docId = "") {
  const id = String(docId || "").trim();
  if (!id) return null;
  const parts = id.split("__");
  if (parts.length < 3) return null;
  const seatId = String(parts[parts.length - 1] || "").trim();
  const boxId = String(parts[parts.length - 2] || "").trim();
  const eventId = parts.slice(0, -2).join("__").trim();
  if (!eventId || !boxId || !seatId) return null;
  return { eventId, boxId, seatId };
}

export function normalizeGlobalSeatFromFirestore(data = {}, docId = "") {
  const firestoreDocId = String(docId || data.__firestoreDocId || "").trim();
  const row = { ...(data || {}) };
  if (firestoreDocId) row.__firestoreDocId = firestoreDocId;

  let seatId = String(row.seatId || row.id || "").trim();
  const parsedFromDoc = firestoreDocId ? parseGlobalSeatDocIdParts(firestoreDocId) : null;
  if (!seatId && parsedFromDoc?.seatId) seatId = parsedFromDoc.seatId;
  if (seatId) row.seatId = seatId;

  if (parsedFromDoc) {
    if (!String(row.currentEventId || "").trim()) row.currentEventId = parsedFromDoc.eventId;
    if (!String(row.mappedEventId || "").trim()) row.mappedEventId = parsedFromDoc.eventId;
    if (!String(row.boxId || "").trim()) row.boxId = parsedFromDoc.boxId;
  }

  if (!String(row.person || "").trim()) row.person = "비어있음";
  row.seatHistory = Array.isArray(row.seatHistory)
    ? row.seatHistory.filter((item) => item && typeof item === "object")
    : [];
  return row;
}

export function getGlobalSeatRowKey(seat = {}) {
  const sid = String(seat?.seatId || "").trim();
  if (sid) return sid;
  return String(seat?.__firestoreDocId || "").trim();
}

export function dedupeGlobalSeats(seats = []) {
  const seen = new Set();
  const out = [];
  for (const raw of seats || []) {
    const row = normalizeGlobalSeatFromFirestore(raw, raw?.__firestoreDocId);
    const key =
      String(row.__firestoreDocId || "").trim() ||
      String(row.seatId || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function getProjectionDocId(eventId = "", boxId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}`;
}

export function getAttendanceDocId(tid = "", uid = "") {
  return `${String(tid || "").trim()}__${String(uid || "").trim()}`;
}

export function getAttendanceRef(db, tid = "", uid = "") {
  return doc(db, "dealer_attendance", getAttendanceDocId(tid, uid));
}

export function getSeatPosition(index = 0) {
  const col = index % 6;
  const row = Math.floor(index / 6);
  return { x: 28 + col * 150, y: 28 + row * 120 };
}

const MIN = 60 * 1000;
const TH_30 = 30 * MIN;
const TH_60 = 60 * MIN;
const TH_90 = 90 * MIN;

export function timerClass(ms) {
  if (ms < TH_30) return "t-green";
  if (ms < TH_60) return "t-yellow";
  if (ms < TH_90) return "t-orange";
  return "t-red";
}

export function fmtElapsed(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const CONFIRM_RECENT_MS = SEAT_SWAP_SETTLE_MS;
const CONFIRM_BLINK_START_MS = SEAT_SWAP_REVEAL_DELAY_MS;
const CONFIRM_BLINK_INTERVAL_MS = 15 * 1000;

/**
 * "배치확인" 이후 5~10분 구간 색 반전(15초 간격) — seatedAt(배치확인 시각) 기준.
 * isRecent: 다음 칸에 seat 번호를 보여줄지(0~10분). isBlinkOn: 지금 이 순간 반전 표시할지.
 */
export function getSeatConfirmHighlightState(seatedAtMs, nowMs = Date.now()) {
  const seatedAt = Number(seatedAtMs) || 0;
  if (!seatedAt) return { isRecent: false, isBlinkPhase: false, isBlinkOn: false };
  const elapsed = nowMs - seatedAt;
  const isRecent = elapsed >= 0 && elapsed < CONFIRM_RECENT_MS;
  const isBlinkPhase = elapsed >= CONFIRM_BLINK_START_MS && elapsed < CONFIRM_RECENT_MS;
  const isBlinkOn = isBlinkPhase && Math.floor(elapsed / CONFIRM_BLINK_INTERVAL_MS) % 2 === 0;
  return { isRecent, isBlinkPhase, isBlinkOn };
}

/**
 * PC 캔버스/Seat 목록 — 좌석 하나에 이름을 하나만 보여줄 때의 표시 상태.
 * admin(isAdminView): 0~5분 다음(신규 배치) 이름 흰색 강조 → 5~10분 15초 간격으로 다음(흰색)·
 * 현재(검은색, 스왑으로 밀려난 이전 occupant) 이름 교대 → 10분 이후 정착.
 * 근무자(!isAdminView): 배치 알림이 뜨는 시점(0~5분)까지는 변경 사실을 숨기고 기존 occupant를
 * 그대로 보여준다(강조 없음) — 5분부터는 admin과 동일하게 반전 표시가 시작된다.
 * 스왑이 아니었으면(이전 occupant 없음) 5~10분도 계속 신규 이름을 유지한 채 반전만 15초 간격.
 */
export function resolveSeatSwapDisplay(seat = {}, nowMs = Date.now(), { isAdminView = true } = {}) {
  const seatedAt = toMillis(seat?.seatedAt);
  const { isRecent, isBlinkPhase, isBlinkOn } = getSeatConfirmHighlightState(seatedAt, nowMs);
  const incomingName = String(seat?.person || "").trim();
  const outgoingName = String(seat?.previousPerson || "").trim();
  const hasOutgoing = !isEmptyPerson(outgoingName);

  if (!isRecent) return { name: incomingName, highlight: false };
  if (!isAdminView && !isBlinkPhase) {
    // 근무자 화면: 공개 시점(REVEAL) 전에는 스왑 사실 자체를 숨긴다.
    return { name: hasOutgoing ? outgoingName : "", highlight: false };
  }
  if (!isBlinkPhase) return { name: incomingName, highlight: true };
  if (!hasOutgoing) return { name: incomingName, highlight: isBlinkOn };
  return isBlinkOn ? { name: incomingName, highlight: true } : { name: outgoingName, highlight: false };
}

/** seat의 previousPerson(스왑으로 밀려난 이전 occupant)이 이 사람인지 */
export function seatMatchesPreviousPerson(s, person = {}) {
  const uid = String(person?.uid || "").trim();
  const name = String(person?.name || "").trim();
  const prevPerson = String(s?.previousPerson || "").trim();
  if (isEmptyPerson(prevPerson)) return false;
  const prevUid = String(s?.previousPersonUid || "").trim();
  if (uid && prevUid) return prevUid === uid;
  return !uid && !prevUid && prevPerson === name;
}

/**
 * 스왑으로 밀려났지만 아직 교대 전환 구간(=이 사람이 "현재" 칸에 계속 보이는 구간)이라
 * 대기 목록에서는 아직 숨겨야 하는 사람인지 — admin이 실수로 이 사람을 다시 배치하는 것 방지.
 */
export function isPersonInPostSwapGrace(seats = [], person = {}) {
  return (seats || []).some((s) => {
    if (!seatMatchesPreviousPerson(s, person)) return false;
    return getSeatConfirmHighlightState(toMillis(s.seatedAt)).isRecent;
  });
}

export function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0;
    if (v <= 0) return 0;
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return Number(v.toMillis()) || 0;
  if (typeof v?.seconds === "number") return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return 0;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) {
      return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
    }
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.floor(n * 1000) : Math.floor(n);
}

export function getSeatById(seatId = "") {
  const id = String(seatId || "").trim();
  if (!id) return null;
  return GL.globalSeats.find((s) => String(s.seatId || "").trim() === id) || null;
}

/** 모바일·시간순 정렬·타이머용 — seatedAt 없으면 updatedAt 보조 */
export function getGlobalSeatSeatedAtMs(seat = {}) {
  if (isEmptyPerson(String(seat.person || "").trim())) return 0;
  const seated = toMillis(seat.seatedAt);
  if (seated > 0) return seated;
  const updated = toMillis(seat.updatedAt);
  if (updated > 0) return updated;
  return 0;
}

/** 점유 Seat: 앉은 시각 오래된 순(위), 빈 Seat: 아래에서 라벨순 */
export function compareGlobalSeatsBySeatedTimeOldest(a = {}, b = {}) {
  const aOccupied = !isEmptyPerson(String(a.person || "").trim());
  const bOccupied = !isEmptyPerson(String(b.person || "").trim());
  if (aOccupied !== bOccupied) return aOccupied ? -1 : 1;
  if (!aOccupied && !bOccupied) return compareSeatsByCanvasLabel(a, b);
  const aTime = getGlobalSeatSeatedAtMs(a);
  const bTime = getGlobalSeatSeatedAtMs(b);
  if (aTime !== bTime) return aTime - bTime;
  return compareSeatsByCanvasLabel(a, b);
}
