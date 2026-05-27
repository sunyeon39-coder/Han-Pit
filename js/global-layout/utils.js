import { doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export { getIsAdmin } from "../shared/auth-helpers.js";
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
