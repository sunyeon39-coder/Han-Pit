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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { GL } from "./state.js";
import { isFirestoreQuotaCoolingDown, noteFirestoreQuotaExceeded } from "../shared/firestore-quota-guard.js";

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
