import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  onSnapshot,
  runTransaction,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isAdminEmail } from "./app_config.js";

const params = new URLSearchParams(location.search);
const tournamentId = params.get("tournamentId") || sessionStorage.getItem("tournamentId") || "";
const urlEventId = String(params.get("eventId") || "").trim();
const urlBoxId = String(params.get("boxId") || "").trim();

const app = document.getElementById("app");
const menuBtn = document.getElementById("menuBtn");
const backBtn = document.getElementById("backBtn");
const seatCountEl = document.getElementById("seatCount");
const waitingCountEl = document.getElementById("waitingCount");
const pcPanel = document.getElementById("pcPanel");
const panelContent = document.getElementById("panelContent");
const tabs = Array.from(document.querySelectorAll(".tab"));

let stopSeatWatch = null;
let stopWaitingWatch = null;
let stopAttendanceWatch = null;
let globalSeats = [];
let globalWaiting = [];
let attendanceWaiting = [];
let selectedWaitingId = "";
let selectedSeatId = "";
let isAdminUser = false;
let hasShownPermissionAlert = false;
let activeTab = "wait";
let dragState = null;
let suppressSeatClickUntil = 0;
let seatSortMode = "seat";
let timerHandle = null;
let panelOpen = false;
let lastGlobalUndo = null;
let waitListScrollTop = 0;
let seatListScrollTop = 0;

function updateTabUi() {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
}

function getUndoStackHint() {
  if (!lastGlobalUndo) return "되돌릴 작업이 없습니다";
  const k = lastGlobalUndo.kind;
  if (k === "add_seat") return "마지막 작업: Seat 추가 — 클릭하면 취소";
  if (k === "assign") return "마지막 작업: 대기 → 배치 — 클릭하면 취소";
  if (k === "delete_seat") return "마지막 작업: Seat 삭제 — 클릭하면 복구";
  if (k === "remove_waiting") return "마지막 작업: 대기 삭제 — 클릭하면 복구";
  return "마지막 작업 되돌리기";
}

function updateGlobalMetaToolbar() {
  const wrap = document.getElementById("globalMetaSeatActions");
  const undoBtn = document.getElementById("globalUndoToolbarBtn");
  if (!wrap || !undoBtn) return;
  const show = isAdminUser && activeTab === "seat";
  wrap.classList.toggle("hidden", !show);
  wrap.setAttribute("aria-hidden", show ? "false" : "true");
  undoBtn.disabled = !lastGlobalUndo;
  undoBtn.title = getUndoStackHint();
}

function getIsAdmin(user, profile) {
  return profile?.role === "admin" || isAdminEmail(user?.email || "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 캔버스 좌석: "Seat" 없이 숫자만 (라벨·no에서 숫자 추출, 없으면 —) */
function seatCanvasDigitsOnly(label, no) {
  const l = String(label ?? "").trim();
  const nStr = no != null && no !== "" ? String(no).trim() : "";
  const fromLabel = l.replace(/\D/g, "");
  if (fromLabel) return fromLabel;
  const fromNo = nStr.replace(/\D/g, "");
  if (fromNo) return fromNo;
  return "—";
}

function isEmptyPerson(name = "") {
  const v = String(name || "").trim();
  return !v || v === "비어있음";
}

function makeUid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function isValidSeatLabel(label = "") {
  const value = String(label || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,15}$/.test(value);
}

/** layout_events 문서 ID 구간 — layout.html 쿼리와 동일해야 함 */
function isValidLayoutRouteIdPart(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/") && !value.includes("__");
}

/** 카드 제목만 넣은 경우(한글만 등) layout doc id 와 불일치하는 실수 방지 */
function looksLikeDisplayTitleNotId(id = "") {
  const value = String(id || "").trim();
  if (!value) return false;
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(value) && !/[A-Za-z0-9]/.test(value)) return true;
  return false;
}

const tournamentEventTitleCache = new Map();

/** index 카드 문서의 title — 사용자 알림 문구용 */
async function resolveTournamentEventTitle(eventId = "") {
  const eid = String(eventId || "").trim();
  if (!eid || !tournamentId) return eid || "이벤트";
  const key = `${tournamentId}\t${eid}`;
  if (tournamentEventTitleCache.has(key)) return tournamentEventTitleCache.get(key);
  try {
    const snap = await getDoc(doc(db, "tournaments", tournamentId, "events", eid));
    const title = snap.exists() ? String((snap.data() || {}).title || "").trim() : "";
    const label = title || eid;
    tournamentEventTitleCache.set(key, label);
    return label;
  } catch (err) {
    console.error("resolveTournamentEventTitle error:", err);
    tournamentEventTitleCache.set(key, eid);
    return eid;
  }
}

function buildGlobalSeatDocId(eventId = "", boxId = "", seatId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}__${String(seatId || "").trim()}`;
}

/**
 * 배치/해제 시 "같은 사람이 이미 앉은 다른 좌석"만 tx.get 하도록 좁힌다.
 * (예전: 대회 전체 좌석마다 순차 tx.get → 느림)
 */
function getCandidateSeatRefsForPerson(person = {}, excludeSeatId = "") {
  const waitingUid = String(person.uid || "").trim();
  const waitingEmail = String(person.email || "").trim().toLowerCase();
  const waitingName = String(person.name || "").trim();
  if (!waitingUid && !waitingEmail && !waitingName) return [];

  const ex = String(excludeSeatId || "").trim();
  const refs = [];
  const seen = new Set();

  for (const s of globalSeats) {
    const sid = String(s?.seatId || "").trim();
    if (!sid || sid === ex) continue;

    const e = String(s?.currentEventId || s?.mappedEventId || "").trim();
    const b = String(s?.boxId || "").trim();
    if (!e || !b) continue;

    const pName = String(s?.person || "").trim();
    if (!pName || isEmptyPerson(pName)) continue;

    const pUid = String(s?.personUid || "").trim();
    const pEmail = String(s?.personEmail || "").trim().toLowerCase();
    const sameUser =
      (waitingUid && pUid && waitingUid === pUid) ||
      (waitingEmail && pEmail && waitingEmail === pEmail) ||
      (!waitingUid && !waitingEmail && waitingName && pName === waitingName);
    if (!sameUser) continue;

    const docId = buildGlobalSeatDocId(e, b, sid);
    if (seen.has(docId)) continue;
    seen.add(docId);
    refs.push(doc(db, "tournaments", tournamentId, "global_seats", docId));
  }

  return refs;
}

function getProjectionDocId(eventId = "", boxId = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}`;
}

/**
 * layout.html 저장본과 구분: syncLayoutProjection만으로 생긴 문서에는 nextSeatNo/nextSeatOrder가 없다.
 * @param {{ requireSeatId?: string }} [opts]
 */
async function validateLayoutEventForGlobalOps(eventId = "", boxId = "", opts = {}) {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b) {
    return { ok: false, message: "eventId와 boxId가 필요합니다." };
  }
  let snap;
  try {
    snap = await getDoc(doc(db, "layout_events", getProjectionDocId(e, b)));
  } catch (err) {
    console.error("validateLayoutEventForGlobalOps getDoc error:", err);
    return { ok: false, message: "layout_events 확인 중 오류가 났습니다." };
  }
  if (!snap.exists()) {
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout_events에 없습니다.\n\n※ index「카드 관리」에서 이 카드 ID·Box ID로 카드를 저장하면 자동으로 생성됩니다. 값이 카드와 다르지 않은지 확인하거나, layout.html에서 한 번 저장해 주세요.`
    };
  }
  const data = snap.data() || {};
  const docTid = String(data.tournamentId || "").trim();
  if (docTid && tournamentId && docTid !== tournamentId) {
    return { ok: false, message: "이 event/box는 현재 대회와 연결되어 있지 않습니다." };
  }
  const hasNextNo = typeof data.nextSeatNo === "number" && Number.isFinite(data.nextSeatNo);
  const hasNextOrder = typeof data.nextSeatOrder === "number" && Number.isFinite(data.nextSeatOrder);
  if (!hasNextNo && !hasNextOrder) {
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout에서 저장된 구성이 아닙니다. index·layout에서 실제 박스를 연 뒤 저장해 주세요.`
    };
  }
  const requireSeatId = String(opts.requireSeatId || "").trim();
  if (requireSeatId) {
    const seats = Array.isArray(data.seats) ? data.seats : [];
    const found = seats.some((s) => String(s?.id || "").trim() === requireSeatId);
    if (!found) {
      return {
        ok: false,
        message: "이 Seat은 배치도에 등록된 좌석이 아닙니다. 잠시 후 다시 시도하거나, layout에서 해당 Seat이 있는지 확인하세요."
      };
    }
  }
  return { ok: true };
}

function getAttendanceDocId(tid = "", uid = "") {
  return `${String(tid || "").trim()}__${String(uid || "").trim()}`;
}

function getAttendanceRef(tid = "", uid = "") {
  return doc(db, "dealer_attendance", getAttendanceDocId(tid, uid));
}

function getSeatPosition(index = 0) {
  const col = index % 6;
  const row = Math.floor(index / 6);
  return { x: 28 + col * 150, y: 28 + row * 120 };
}

const MIN = 60 * 1000;
const TH_30 = 30 * MIN;
const TH_60 = 60 * MIN;
const TH_90 = 90 * MIN;
function timerClass(ms) {
  if (ms < TH_30) return "t-green";
  if (ms < TH_60) return "t-yellow";
  if (ms < TH_90) return "t-orange";
  return "t-red";
}

/** 캔버스 좌석 카드: 배치 경과 시간에 따른 t-green~t-red (1초 틱에서 갱신) */
function updateCanvasSeatTimerClasses() {
  if (!app) return;
  const root = app.querySelector(".pc-canvas");
  if (!root) return;
  const now = Date.now();
  root.querySelectorAll(".seat-box[data-seat-id]").forEach((box) => {
    const id = String(box.getAttribute("data-seat-id") || "").trim();
    const s = globalSeats.find((x) => String(x.seatId || "").trim() === id);
    if (!s || isEmptyPerson(String(s.person || "").trim())) {
      box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      return;
    }
    const seatedAtMs = toMillis(s.seatedAt || 0);
    const elapsed = seatedAtMs > 0 ? now - seatedAtMs : 0;
    const cls = timerClass(elapsed);
    box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    box.classList.add(cls);
  });
}

function fmtElapsed(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0;
    if (v <= 0) return 0;
    // Some legacy docs may store epoch seconds instead of milliseconds.
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toMillis === "function") return Number(v.toMillis()) || 0;
  if (typeof v?.seconds === "number") return (v.seconds * 1000) + Math.floor((v.nanoseconds || 0) / 1e6);
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

function setPanelOpen(nextOpen) {
  panelOpen = !!nextOpen;
  pcPanel?.classList.toggle("open", panelOpen);
  app?.classList.toggle("with-panel", panelOpen);
}

function capturePanelScroll() {
  const list = panelContent?.querySelector(".global-list");
  if (!list) return;
  if (activeTab === "seat") {
    seatListScrollTop = list.scrollTop;
  } else {
    waitListScrollTop = list.scrollTop;
  }
}

function restorePanelScroll() {
  const list = panelContent?.querySelector(".global-list");
  if (!list) return;
  if (activeTab === "seat") {
    list.scrollTop = seatListScrollTop;
  } else {
    list.scrollTop = waitListScrollTop;
  }
}

function isTypingInPanel() {
  const el = document.activeElement;
  if (!el) return false;
  if (!(el instanceof HTMLElement)) return false;
  if (!panelContent?.contains(el)) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

function getSeatById(seatId = "") {
  const id = String(seatId || "").trim();
  if (!id) return null;
  return globalSeats.find((s) => String(s.seatId || "").trim() === id) || null;
}

/** URL → sessionStorage → 기존 좌석 비율 → 1/1 (layout.html 과 동일한 eventId·boxId 문자열) */
function getDefaultEventBoxForNewSeat() {
  if (urlEventId && urlBoxId) return { eventId: urlEventId, boxId: urlBoxId };

  const se = String(sessionStorage.getItem("eventId") || "").trim();
  const sb = String(sessionStorage.getItem("boxId") || "").trim();
  if (se && sb) return { eventId: se, boxId: sb };

  const counts = new Map();
  globalSeats.forEach((s) => {
    const e = String(s.currentEventId || s.mappedEventId || "").trim();
    const b = String(s.boxId || "").trim();
    if (!e || !b) return;
    const k = `${e}\t${b}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  let bestKey = "";
  let best = 0;
  counts.forEach((n, k) => {
    if (n > best) {
      best = n;
      bestKey = k;
    }
  });
  if (bestKey) {
    const [e, b] = bestKey.split("\t");
    return { eventId: e, boxId: b };
  }
  return { eventId: "1", boxId: "1" };
}

async function undoAssignPayload(payload) {
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const seatRef = doc(
    db,
    "tournaments",
    tournamentId,
    "global_seats",
    buildGlobalSeatDocId(payload.eventId, payload.boxId, payload.targetSeatId)
  );
  const now = Date.now();
  const waitingRow = payload.waiting && typeof payload.waiting === "object" ? payload.waiting : null;
  if (!waitingRow) throw new Error("undo_assign_missing_waiting");

  await runTransaction(db, async (tx) => {
    const wSnap = await tx.get(waitingRef);
    const wData = wSnap.exists() ? wSnap.data() || {} : {};
    const arr = Array.isArray(wData.waiting) ? [...wData.waiting] : [];
    const wid = String(waitingRow.id || "").trim();
    const filtered = wid ? arr.filter((w) => String(w?.id || "").trim() !== wid) : arr;
    filtered.push(waitingRow);

    tx.set(
      seatRef,
      {
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    tx.set(
      waitingRef,
      {
        ...wData,
        version: 2,
        waiting: filtered,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    const uid = String(waitingRow.uid || "").trim();
    if (uid) {
      tx.set(
        getAttendanceRef(tournamentId, uid),
        {
          uid,
          email: String(waitingRow.email || "").trim(),
          name: String(waitingRow.name || "").trim(),
          tournamentId,
          status: "waiting",
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(payload.eventId, payload.boxId);
}

async function undoLastGlobalAction() {
  if (!isAdminUser || !lastGlobalUndo) return;
  const snap = lastGlobalUndo;
  lastGlobalUndo = null;
  try {
    if (snap.kind === "add_seat") {
      await deleteDoc(
        doc(
          db,
          "tournaments",
          tournamentId,
          "global_seats",
          buildGlobalSeatDocId(snap.eventId, snap.boxId, snap.seatId)
        )
      );
      await syncLayoutProjection(snap.eventId, snap.boxId);
    } else if (snap.kind === "assign") {
      await undoAssignPayload(snap);
    } else if (snap.kind === "delete_seat") {
      const d = snap.seatDoc && typeof snap.seatDoc === "object" ? snap.seatDoc : {};
      const sid = String(snap.seatId || d.seatId || "").trim();
      const eid = String(snap.eventId || d.currentEventId || d.mappedEventId || "").trim();
      const bid = String(snap.boxId || d.boxId || "").trim();
      if (!sid || !eid || !bid) throw new Error("undo_delete_bad_ref");
      await setDoc(
        doc(db, "tournaments", tournamentId, "global_seats", buildGlobalSeatDocId(eid, bid, sid)),
        d,
        { merge: true }
      );
      await syncLayoutProjection(eid, bid);
    } else if (snap.kind === "remove_waiting") {
      await updateGlobalWaiting(Array.isArray(snap.snapshotBefore) ? snap.snapshotBefore : []);
    } else {
      throw new Error("undo_unknown_kind");
    }
  } catch (err) {
    console.error("undoLastGlobalAction error:", err);
    lastGlobalUndo = snap;
    alert("되돌리기에 실패했습니다.");
    updateGlobalMetaToolbar();
    return;
  }

  if (activeTab === "seat") renderSeatPanel();
  else renderWaiting(getCurrentTournamentWaiting());
}

async function saveSeatPosition(seatId = "", x = 0, y = 0) {
  const seat = getSeatById(seatId);
  if (!seat) return;
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return;
  const docId = buildGlobalSeatDocId(eventId, boxId, seatId);
  await setDoc(
    doc(db, "tournaments", tournamentId, "global_seats", docId),
    {
      x: Math.max(0, Math.round(Number(x) || 0)),
      y: Math.max(0, Math.round(Number(y) || 0)),
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

/**
 * 대기 행과 동일한 신원이 이미 global_seats에 앉아 있는지 (uid / email / 이름-only)
 * 수동 대기(uid 없음) 배치 직후 global_waiting 스냅샷이 늦어도 대기 UI에서 즉시 제외한다.
 */
function isPersonSeatedInGlobalSeats(person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || person.nickname || "").trim();
  return globalSeats.some((s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    const pUid = String(s?.personUid || "").trim();
    const pEmail = String(s?.personEmail || "").trim().toLowerCase();
    const pName = String(s?.person || "").trim();
    if (uid && pUid && uid === pUid) return true;
    if (email && pEmail && email === pEmail) return true;
    if (!uid && !email && name && pName === name) return true;
    return false;
  });
}

function getCurrentTournamentWaiting() {
  const waitingBase = globalWaiting
    .filter((w) => String(w?.tournamentId || "").trim() === tournamentId)
    .filter((w) => !isPersonSeatedInGlobalSeats({
      uid: w?.uid,
      email: w?.email,
      name: w?.name
    }));

  const merged = [...waitingBase];
  const hasEntry = (candidate = {}) => {
    const cUid = String(candidate.uid || "").trim();
    const cEmail = String(candidate.email || "").trim();
    const cName = String(candidate.name || "").trim();
    return merged.some((w) => {
      const wUid = String(w?.uid || "").trim();
      const wEmail = String(w?.email || "").trim();
      const wName = String(w?.name || "").trim();
      if (cUid && wUid && cUid === wUid) return true;
      if (cEmail && wEmail && cEmail === wEmail) return true;
      if (!cUid && !cEmail && cName && wName === cName) return true;
      return false;
    });
  };

  attendanceWaiting.forEach((item) => {
    const uid = String(item?.uid || "").trim();
    if (isPersonSeatedInGlobalSeats({
      uid,
      email: item?.email,
      name: item?.nickname || item?.name
    })) {
      return;
    }
    if (hasEntry(item)) return;
    merged.push({
      id: String(item.id || `att_${uid || makeUid("att")}`),
      uid,
      email: String(item.email || "").trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-",
      tournamentId,
      joinedAt: Number(item.statusChangedAt || item.checkedInAt || Date.now()) || Date.now(),
      source: "attendance_fallback"
    });
  });

  return merged;
}

async function syncLayoutProjection(eventId = "", boxId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b || !tournamentId) return;

  /**
   * 메모리의 globalSeats는 onSnapshot보다 늦게 갱신될 수 있다.
   * setDoc 직후에 여기서 globalSeats만 쓰면 새 좌석이 빠진 채 layout_events가 덮어써지고,
   * layout.html 저장 시 syncGlobalSeatsForCurrentLayout이 그 좌석 global 문서를 삭제한다.
   * 항상 서버에서 최신 global_seats를 읽어 투영한다.
   */
  let liveRows = [];
  try {
    const layoutDocId = getProjectionDocId(e, b);
    const q = query(
      collection(db, "tournaments", tournamentId, "global_seats"),
      where("sourceLayoutDocId", "==", layoutDocId)
    );
    const snap = await getDocs(q);
    liveRows = snap.docs.map((d) => d.data() || {});
  } catch (err) {
    console.error("syncLayoutProjection getDocs error:", err);
    liveRows = globalSeats.filter((s) => {
      const eid = String(s.currentEventId || s.mappedEventId || "").trim();
      return eid === e && String(s.boxId || "").trim() === b;
    });
  }

  const seats = liveRows
    .filter((s) => {
      const eid = String(s.currentEventId || s.mappedEventId || "").trim();
      return eid === e && String(s.boxId || "").trim() === b;
    })
    .sort((a, b2) => Number(a.order || 0) - Number(b2.order || 0))
    .map((s) => ({
      id: String(s.seatId || "").trim(),
      label: String(s.label || "").trim(),
      no: Number(s.no || 0) || 0,
      order: Number(s.order || 0) || 0,
      person: isEmptyPerson(s.person) ? "비어있음" : String(s.person || "").trim(),
      personUid: String(s.personUid || "").trim(),
      personEmail: String(s.personEmail || "").trim(),
      seatedAt: s.seatedAt ? Number(s.seatedAt) : null,
      x: Number(s.x || 0) || 0,
      y: Number(s.y || 0) || 0
    }));

  await setDoc(
    doc(db, "layout_events", getProjectionDocId(e, b)),
    {
      version: 2,
      tournamentId,
      eventId: e,
      boxId: b,
      seats,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

function renderSeats(seats = []) {
  if (!app) return;
  if (!seats.length) {
    app.innerHTML = `
      <div class="canvas pc-canvas">
        <div class="canvas-inner">
          <div class="empty-panel" style="position:absolute;left:24px;top:24px;width:260px;">
            아직 생성된 전역 좌석이 없습니다.
          </div>
        </div>
      </div>
    `;
    seatCountEl.textContent = "SEAT: 0";
    return;
  }

  seatCountEl.textContent = `SEAT: ${seats.length}`;
  const sorted = [...seats].sort((a, b) => (a.order || 0) - (b.order || 0));
  const seatHtml = sorted.map((s, idx) => {
    const label = s.label || s.no || s.seatId || "-";
    const occupied = !isEmptyPerson(String(s.person || "").trim());
    const name = occupied ? String(s.person || "").trim() : "-";
    const personClass = occupied ? "seat-person" : "seat-person is-empty";
    const seatId = String(s.seatId || "").trim();
    const selectedClass = selectedSeatId === seatId ? "selected" : "";
    const x = Number.isFinite(Number(s.x)) ? Number(s.x) : getSeatPosition(idx).x;
    const y = Number.isFinite(Number(s.y)) ? Number(s.y) : getSeatPosition(idx).y;
    const seatedAtMs = occupied ? toMillis(s.seatedAt || 0) : 0;
    const elapsedMs = occupied ? (seatedAtMs > 0 ? Date.now() - seatedAtMs : 0) : 0;
    const timerCls = occupied ? timerClass(elapsedMs) : "";
    const seatBoxClass = ["seat-box", occupied ? "is-occupied" : "", timerCls, selectedClass]
      .filter(Boolean)
      .join(" ");
    const canvasLabel = String(s.label ?? s.no ?? "").trim() || "—";
    return `
      <div class="${seatBoxClass}" data-seat-id="${escapeHtml(seatId)}" style="left:${x}px;top:${y}px;">
        <div class="seat-title">SEAT ${escapeHtml(canvasLabel)}</div>
        <div class="${personClass}">${escapeHtml(name)}</div>
      </div>
    `;
  }).join("");

  app.innerHTML = `
    <div class="canvas pc-canvas">
      <div class="canvas-inner">
        ${seatHtml}
      </div>
    </div>
  `;
  updateCanvasSeatTimerClasses();
}

function renderWaiting(waiting = []) {
  if (!panelContent) return;
  capturePanelScroll();
  const waitTabActive = activeTab === "wait";
  updateTabUi();

  if (!waitTabActive) {
    renderSeatPanel();
    return;
  }

    const waitingRows = waiting.map((w, idx) => {
    const wid = String(w.id || "");
    const selected = selectedWaitingId === wid;
    const joinedAt = toMillis(
      w.joinedAt ||
      w.createdAt ||
      w.joinedAtServer ||
      w.updatedAtServer ||
      w.updatedAt ||
      w.addedAt ||
      w.carryStartedAt ||
      0
    ) || Date.now();
    const elapsed = Date.now() - joinedAt;
    const tClass = timerClass(elapsed);
    return `
    <div class="wait-manage-row ${selected ? "selected" : ""}" data-wid="${escapeHtml(wid)}">
      <div class="wait-manage-main">
        <div class="wait-manage-inline">
          <div class="wait-order-badge">${escapeHtml(String(idx + 1))}</div>
          <div class="mini-name-wrap">
            <div class="wait-name-text">${escapeHtml(w.name || w.uid || "-")}</div>
          </div>
        </div>
        <div class="seat-inline-actions">
          <span class="time-chip ${tClass}">${fmtElapsed(elapsed)}</span>
          <button class="pill-inline danger" data-delete-wid="${escapeHtml(wid)}" type="button">삭제</button>
        </div>
      </div>
    </div>
  `;
  }).join("");

  panelContent.innerHTML = `
    <div class="global-form single admin-only ${isAdminUser ? "" : "hidden"}">
      <input id="manualWaitingNameInput" placeholder="대기자 이름 입력" autocomplete="off" />
      <button id="addManualWaitingBtn" class="pill-inline full" type="button">+ 대기 추가</button>
    </div>
    <div class="global-list">
      ${waitingRows || `<div class="empty-panel">현재 대기자가 없습니다.</div>`}
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
}

function renderSeatPanel() {
  if (!panelContent) return;
  capturePanelScroll();
  updateTabUi();
  const sorted = [...globalSeats].sort((a, b) => {
    if (seatSortMode === "time") {
      const at = Number(a.seatedAt || 0);
      const bt = Number(b.seatedAt || 0);
      return bt - at;
    }
    return (a.order || 0) - (b.order || 0);
  });
  const rows = sorted.map((s) => {
    const eventId = s.currentEventId || s.mappedEventId || "-";
    const boxId = s.boxId || "-";
    const occupied = !isEmptyPerson(String(s.person || "").trim());
    const name = occupied ? String(s.person || "").trim() : "-";
    const seatId = String(s.seatId || "").trim();
    const selectedRowClass = selectedSeatId === seatId ? "selected" : "";
    const seatedAt = toMillis(s.seatedAt || 0);
    const elapsed = seatedAt ? Date.now() - seatedAt : 0;
    const tClass = timerClass(elapsed);
    return `
      <div class="seat-manage-row ${selectedRowClass}" data-select-seat="${escapeHtml(seatId)}">
        <div class="seat-manage-main seat-manage-main--oneline">
          <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
            <span class="seat-manage-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
            <div class="seat-manage-namecol">
              <span class="seat-manage-name ${occupied ? "" : "is-empty"}">${escapeHtml(name)}</span>
              <span class="meta-line seat-manage-submeta">event: ${escapeHtml(eventId)} / box: ${escapeHtml(boxId)}</span>
            </div>
          </div>
          <div class="seat-inline-actions">
            ${occupied ? `<span class="time-chip ${tClass}">${fmtElapsed(elapsed)}</span>` : `<span class="seat-manage-empty-dash">-</span>`}
            ${
              isAdminUser
                ? (!occupied
                  ? `<button class="pill-inline" data-assign-seat="${escapeHtml(seatId)}">여기 배치</button>`
                  : ``)
                : ``
            }
            ${isAdminUser ? `<button class="pill-inline" type="button" data-rename-seat="${escapeHtml(seatId)}">수정</button>` : ``}
            ${isAdminUser ? `<button class="pill-inline danger" data-delete-seat="${escapeHtml(seatId)}">삭제</button>` : ``}
          </div>
        </div>
      </div>
    `;
  }).join("");

  const defEb = getDefaultEventBoxForNewSeat();
  const seatAddTitle = `카드 제목이 아니라 index「카드 관리」의 카드 ID·Box ID (layout.html URL의 eventId·boxId)와 동일해야 합니다. 비우면 ${defEb.eventId} / ${defEb.boxId} 사용.`;

  panelContent.innerHTML = `
    <div
      class="global-form-seat-add admin-only ${isAdminUser ? "" : "hidden"}"
      title="${escapeHtml(seatAddTitle)}"
    >
      <div class="seat-add-one-row">
        <input
          id="seatLabelInput"
          class="seat-add-input seat-add-input--label"
          type="text"
          placeholder="라벨 · 예: 1, A1"
          autocomplete="off"
          aria-label="Seat 라벨"
        />
        <input
          id="seatEventInput"
          class="seat-add-input seat-add-input--meta"
          type="text"
          placeholder="카드 ID"
          value="${escapeHtml(defEb.eventId)}"
          autocomplete="off"
          aria-label="이벤트 카드 ID (layout eventId)"
        />
        <input
          id="seatBoxInput"
          class="seat-add-input seat-add-input--meta"
          type="text"
          placeholder="Box ID"
          value="${escapeHtml(defEb.boxId)}"
          autocomplete="off"
          aria-label="Box ID (layout boxId)"
        />
        <button
          type="button"
          id="addSeatToolbarBtn"
          class="pill-inline primary seat-meta-btn seat-add-action-btn"
          title="+ Seat 추가"
        >
          추가
        </button>
      </div>
    </div>
    <div class="seat-sort-row">
      <button id="sortSeatOrderBtn" class="pill-inline ${seatSortMode === "seat" ? "active" : ""}" type="button">Seat순</button>
      <button id="sortSeatTimeBtn" class="pill-inline ${seatSortMode === "time" ? "active" : ""}" type="button">시간순</button>
    </div>
    <div class="global-list">
      ${rows || `<div class="empty-panel">전역 좌석이 없습니다.</div>`}
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
}

async function updateGlobalWaiting(nextWaiting = []) {
  await setDoc(
    doc(db, "layout_shared", "global_waiting"),
    {
      version: 2,
      waiting: nextWaiting,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

async function assignSelectedWaitingToSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;

  const seat = globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const ev0 = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const bx0 = String(seat.boxId || "").trim();
  const layoutGate = await validateLayoutEventForGlobalOps(ev0, bx0, { requireSeatId: targetSeatId });
  if (!layoutGate.ok) {
    alert(layoutGate.message);
    return;
  }

  const waitingList = getCurrentTournamentWaiting();
  const waiting = waitingList.find((w) => String(w.id || "") === String(selectedWaitingId || ""));
  if (!waiting) {
    alert("먼저 대기 행을 눌러 배치할 사람을 지정하세요.");
    return;
  }

  const evForMsg = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const eventDisplayTitle = await resolveTournamentEventTitle(evForMsg);

  const now = Date.now();
  const seatRef = doc(
    db,
    "tournaments",
    tournamentId,
    "global_seats",
    buildGlobalSeatDocId(seat.currentEventId, seat.boxId, seat.seatId)
  );
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const touchedProjectionKeys = new Set();

  await runTransaction(db, async (tx) => {
    const waitingId = String(waiting.id || "").trim();
    const waitingUid = String(waiting.uid || "").trim();
    const waitingEmail = String(waiting.email || "").trim();
    const waitingName = String(waiting.name || "").trim();
    const waitingTournamentId = String(waiting.tournamentId || tournamentId).trim();

    const dupRefs = getCandidateSeatRefsForPerson(
      { uid: waitingUid, email: waitingEmail, name: waitingName },
      targetSeatId
    );

    const [seatSnap, waitingSnap, ...dupSnaps] = await Promise.all([
      tx.get(seatRef),
      tx.get(waitingRef),
      ...dupRefs.map((r) => tx.get(r))
    ]);

    if (!seatSnap.exists()) throw new Error("seat_not_found");
    const seatData = seatSnap.data() || {};
    if (!isEmptyPerson(seatData.person)) throw new Error("seat_already_occupied");

    const waitingData = waitingSnap.exists() ? (waitingSnap.data() || {}) : { waiting: [] };
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];

    const nextWaiting = waitingArr.filter((w) => {
      if (!w || typeof w !== "object") return false;
      const wId = String(w.id || "").trim();
      const wUid = String(w.uid || "").trim();
      const wEmail = String(w.email || "").trim();
      const wName = String(w.name || "").trim();
      const wTid = String(w.tournamentId || "").trim();
      const sameTournament = !wTid || wTid === waitingTournamentId;
      if (!sameTournament) return true;
      if (waitingId && wId === waitingId) return false;
      if (waitingUid && wUid && wUid === waitingUid) return false;
      if (waitingEmail && wEmail && wEmail === waitingEmail) return false;
      if (!waitingUid && !waitingEmail && waitingName && wName === waitingName) return false;
      return true;
    });

    // Heal stale state: if the same user is still seated elsewhere, clear those seats first.
    if (waitingUid || waitingEmail || waitingName) {
      for (let i = 0; i < dupSnaps.length; i++) {
        const docSnap = dupSnaps[i];
        if (!docSnap.exists()) continue;
        const ref = dupRefs[i];
        const data = docSnap.data() || {};
        const docSeatId = String(data.seatId || "").trim();
        if (docSeatId === targetSeatId) continue;
        const dUid = String(data.personUid || "").trim();
        const dEmail = String(data.personEmail || "").trim();
        const dName = String(data.person || "").trim();
        const sameUser =
          (waitingUid && dUid && waitingUid === dUid) ||
          (waitingEmail && dEmail && waitingEmail === dEmail) ||
          (!waitingUid && !waitingEmail && waitingName && dName === waitingName);
        if (!sameUser) continue;
        tx.set(
          ref,
          {
            person: "비어있음",
            personUid: "",
            personEmail: "",
            seatedAt: null,
            status: "empty",
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
        const kEvent = String(data.currentEventId || data.mappedEventId || "").trim();
        const kBox = String(data.boxId || "").trim();
        if (kEvent && kBox) touchedProjectionKeys.add(`${kEvent}__${kBox}`);
      }
    }

    tx.set(
      seatRef,
      {
        person: String(waiting.name || "").trim(),
        personUid: String(waiting.uid || "").trim(),
        personEmail: String(waiting.email || "").trim(),
        seatedAt: now,
        status: "occupied",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    tx.set(
      waitingRef,
      {
        ...waitingData,
        version: 2,
        waiting: nextWaiting,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    if (waiting.uid) {
      tx.set(
        getAttendanceRef(tournamentId, waiting.uid),
        {
          uid: String(waiting.uid || "").trim(),
          email: String(waiting.email || "").trim(),
          name: String(waiting.name || "").trim(),
          tournamentId,
          status: "assigned",
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      tx.set(
        doc(db, "layout_notifications", waiting.uid),
        {
          type: "seat_assigned",
          acknowledged: false,
          createdAt: now,
          tournamentId,
          eventId: seat.currentEventId || "",
          eventTitle: eventDisplayTitle,
          boxId: seat.boxId || "",
          seatId: seat.seatId || "",
          seatLabel: seat.label || seat.no || "",
          targetUrl: `./layout.html?tournamentId=${encodeURIComponent(tournamentId)}&eventId=${encodeURIComponent(seat.currentEventId || "")}&boxId=${encodeURIComponent(seat.boxId || "")}&focusSeatId=${encodeURIComponent(seat.seatId || "")}`,
          message: `${eventDisplayTitle} / Seat ${seat.label || seat.no || ""}에 배치되었습니다.`,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  selectedWaitingId = "";
  selectedSeatId = targetSeatId;
  const ev = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const bx = String(seat.boxId || "").trim();
  lastGlobalUndo = {
    kind: "assign",
    targetSeatId,
    eventId: ev,
    boxId: bx,
    waiting: JSON.parse(JSON.stringify(waiting))
  };
  await syncLayoutProjection(ev, bx);
  await Promise.all(
    Array.from(touchedProjectionKeys).map(async (k) => {
      const [e, b] = String(k || "").split("__");
      if (!e || !b) return;
      if (e === ev && b === bx) return;
      await syncLayoutProjection(e, b);
    })
  );
}

async function clearSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;
  const seat = globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const now = Date.now();
  const seatRef = doc(
    db,
    "tournaments",
    tournamentId,
    "global_seats",
    buildGlobalSeatDocId(seat.currentEventId, seat.boxId, seat.seatId)
  );
  const waitingRef = doc(db, "layout_shared", "global_waiting");

  await runTransaction(db, async (tx) => {
    const seatSnap = await tx.get(seatRef);
    if (!seatSnap.exists()) throw new Error("seat_not_found");
    const seatData = seatSnap.data() || {};
    const prevUid = String(seatData.personUid || "").trim();
    const prevEmail = String(seatData.personEmail || "").trim();
    const prevName = String(seatData.person || "").trim();

    const otherRefs = getCandidateSeatRefsForPerson(
      { uid: prevUid, email: prevEmail, name: prevName },
      targetSeatId
    );

    const [waitingSnap, ...otherSnaps] = await Promise.all([
      tx.get(waitingRef),
      ...otherRefs.map((r) => tx.get(r))
    ]);

    const waitingData = waitingSnap.exists() ? (waitingSnap.data() || {}) : { waiting: [] };
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
    let hasOtherSeat = false;

    tx.set(
      seatRef,
      {
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    if (!isEmptyPerson(prevName)) {
      hasOtherSeat = otherSnaps.some((docSnap) => {
        if (!docSnap.exists()) return false;
        const data = docSnap.data() || {};
        const dSeatId = String(data.seatId || "").trim();
        if (dSeatId === targetSeatId) return false;
        const dUid = String(data.personUid || "").trim();
        const dEmail = String(data.personEmail || "").trim();
        const dName = String(data.person || "").trim();
        const sameUser =
          (prevUid && dUid && prevUid === dUid) ||
          (prevEmail && dEmail && prevEmail === dEmail) ||
          (!prevUid && !prevEmail && prevName && dName === prevName);
        if (!sameUser) return false;
        return !isEmptyPerson(dName);
      });

      const exists = waitingArr.some((w) => {
        const wTournamentId = String(w?.tournamentId || "").trim();
        const sameTournament = !wTournamentId || wTournamentId === tournamentId;
        if (!sameTournament) return false;
        const wUid = String(w?.uid || "").trim();
        const wEmail = String(w?.email || "").trim();
        const wName = String(w?.name || "").trim();
        if (prevUid && wUid && wUid === prevUid) return true;
        if (prevEmail && wEmail && wEmail === prevEmail) return true;
        if (!prevUid && !prevEmail && prevName && wName === prevName) return true;
        return false;
      });

      if (!hasOtherSeat && !exists) {
        const nextWaiting = [
          ...waitingArr,
          {
            id: makeUid("wait"),
            uid: prevUid,
            email: prevEmail,
            name: prevName,
            tournamentId,
            joinedAt: now
          }
        ];
        tx.set(
          waitingRef,
          {
            ...waitingData,
            version: 2,
            waiting: nextWaiting,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
      }
    }

    if (prevUid) {
      tx.set(
        getAttendanceRef(tournamentId, prevUid),
        {
          uid: prevUid,
          email: prevEmail,
          name: prevName,
          tournamentId,
          status: hasOtherSeat ? "assigned" : "waiting",
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      tx.set(
        doc(db, "layout_notifications", prevUid),
        {
          type: "seat_cleared",
          acknowledged: true,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(seat.currentEventId, seat.boxId);
  lastGlobalUndo = null;
}

async function deleteGlobalSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;
  const seat = getSeatById(targetSeatId);
  if (!seat) return;
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return;
  const ref = doc(db, "tournaments", tournamentId, "global_seats", buildGlobalSeatDocId(eventId, boxId, targetSeatId));
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const seatDoc = snap.data() || {};
  await deleteDoc(ref);
  if (selectedSeatId === targetSeatId) selectedSeatId = "";
  lastGlobalUndo = { kind: "delete_seat", seatId: targetSeatId, eventId, boxId, seatDoc };
  await syncLayoutProjection(eventId, boxId);
}

async function renameGlobalSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;
  const seat = getSeatById(targetSeatId);
  if (!seat) return;

  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return;

  const prevLabel = String(seat.label ?? seat.no ?? "").trim();
  const msg = `Seat 라벨을 입력하세요 (영문/숫자, 공백·_- 허용, 최대 16자)\n현재: ${prevLabel}`;
  const input = window.prompt(msg, prevLabel);
  if (input === null) return;

  const nextLabel = String(input).trim();
  if (!nextLabel || nextLabel === prevLabel) return;

  if (!isValidSeatLabel(nextLabel)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return;
  }

  const layoutGate = await validateLayoutEventForGlobalOps(eventId, boxId, { requireSeatId: targetSeatId });
  if (!layoutGate.ok) {
    alert(layoutGate.message);
    return;
  }

  const eventDisplayTitle = await resolveTournamentEventTitle(eventId);

  const now = Date.now();
  const ref = doc(db, "tournaments", tournamentId, "global_seats", buildGlobalSeatDocId(eventId, boxId, targetSeatId));

  await setDoc(
    ref,
    {
      label: nextLabel,
      updatedAt: now,
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );

  const uid = String(seat.personUid || "").trim();
  if (uid) {
    await setDoc(
      getAttendanceRef(tournamentId, uid),
      {
        uid,
        tournamentId,
        currentSeatLabel: nextLabel,
        currentEventId: eventId,
        currentBoxId: boxId,
        currentSeatId: targetSeatId,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    await setDoc(
      doc(db, "layout_notifications", uid),
      {
        type: "seat_assigned",
        acknowledged: false,
        createdAt: now,
        tournamentId,
        eventId,
        eventTitle: eventDisplayTitle,
        boxId,
        seatId: targetSeatId,
        seatLabel: nextLabel,
        targetUrl: `./layout.html?tournamentId=${encodeURIComponent(tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`,
        message: `${eventDisplayTitle} / Seat ${nextLabel} 라벨이 변경되었습니다.`,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  }

  await syncLayoutProjection(eventId, boxId);

  const idx = globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
  if (idx >= 0) {
    globalSeats[idx] = { ...globalSeats[idx], label: nextLabel };
  }
  if (activeTab === "seat") renderSeatPanel();
  renderSeats(globalSeats);
}

async function addGlobalSeat() {
  const seatLabelInput = document.getElementById("seatLabelInput");
  const seatEventInput = document.getElementById("seatEventInput");
  const seatBoxInput = document.getElementById("seatBoxInput");
  const label = String(seatLabelInput?.value || "").trim();
  const fallbackEb = getDefaultEventBoxForNewSeat();
  const eventId = String(seatEventInput?.value || "").trim() || fallbackEb.eventId;
  const boxId = String(seatBoxInput?.value || "").trim() || fallbackEb.boxId;
  if (!label) {
    alert("Seat 라벨을 입력하세요.");
    return;
  }
  if (!eventId || !boxId) {
    alert("eventId와 boxId를 입력하거나, index에서 이벤트 카드를 선택한 뒤 다시 시도하세요.");
    return;
  }
  if (!isValidLayoutRouteIdPart(eventId) || !isValidLayoutRouteIdPart(boxId)) {
    alert(
      "카드 ID / Box ID 형식이 올바르지 않습니다. (비어 있지 않고, / 나 __ 는 사용할 수 없습니다.)\nindex「카드 관리」에 표시된 값과 layout.html 주소창의 eventId·boxId를 확인하세요."
    );
    return;
  }
  if (looksLikeDisplayTitleNotId(eventId)) {
    alert(
      "EVENT 칸에는 카드 제목이 아니라 카드 ID(예: 숫자·event_1)를 넣어야 합니다.\nindex「카드 관리」에서 해당 카드를 선택하면 카드 ID·Box ID가 보입니다."
    );
    return;
  }

  const layoutGate = await validateLayoutEventForGlobalOps(eventId, boxId);
  if (!layoutGate.ok) {
    alert(layoutGate.message);
    return;
  }

  if (!isValidSeatLabel(label)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return;
  }

  const now = Date.now();
  const seatId = `seat_${makeUid("g").slice(-8)}`;
  const order = globalSeats.length + 1;
  const docId = buildGlobalSeatDocId(eventId, boxId, seatId);

  await setDoc(
    doc(db, "tournaments", tournamentId, "global_seats", docId),
    {
      seatId,
      label,
      no: order,
      order,
      x: 0,
      y: 0,
      person: "비어있음",
      personUid: "",
      personEmail: "",
      seatedAt: null,
      status: "empty",
      tournamentId,
      mappedEventId: eventId,
      currentEventId: eventId,
      boxId,
      sourceLayoutDocId: `${eventId}__${boxId}`,
      updatedAt: now,
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );

  await syncLayoutProjection(eventId, boxId);
  sessionStorage.setItem("eventId", eventId);
  sessionStorage.setItem("boxId", boxId);
  lastGlobalUndo = { kind: "add_seat", seatId, eventId, boxId };
  seatLabelInput.value = "";
  if (seatEventInput) seatEventInput.value = eventId;
  if (seatBoxInput) seatBoxInput.value = boxId;
}

async function addManualWaiting() {
  const input = document.getElementById("manualWaitingNameInput");
  const name = String(input?.value || "").trim();
  if (!name) {
    alert("대기자 이름을 입력하세요.");
    return;
  }

  const current = getCurrentTournamentWaiting();
  const now = Date.now();
  const next = [
    ...current,
    {
      id: makeUid("wait"),
      uid: "",
      email: "",
      name,
      tournamentId,
      joinedAt: now
    }
  ];
  await updateGlobalWaiting(next);
  if (input) input.value = "";
}

async function removeManualWaiting(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  const snapshotBefore = JSON.parse(JSON.stringify(getCurrentTournamentWaiting()));
  const next = snapshotBefore.filter((w) => String(w?.id || "") !== wid);
  await updateGlobalWaiting(next);
  lastGlobalUndo = { kind: "remove_waiting", snapshotBefore };
  if (selectedWaitingId === wid) selectedWaitingId = "";
}

function bindRealtime() {
  if (!tournamentId) {
    alert("대회 정보가 없습니다.");
    location.replace("./index.html");
    return;
  }

  sessionStorage.setItem("tournamentId", tournamentId);

  if (stopSeatWatch) stopSeatWatch();
  stopSeatWatch = onSnapshot(
    collection(db, "tournaments", tournamentId, "global_seats"),
    (snap) => {
      globalSeats = snap.docs.map((d) => d.data() || {});
      renderSeats(globalSeats);
      if (activeTab === "seat") renderSeatPanel();
      if (activeTab === "wait") {
        renderWaiting(getCurrentTournamentWaiting());
      }
    },
    (err) => {
      console.error("global seats watch error:", err);
      if (String(err?.code || "").includes("permission-denied") && !hasShownPermissionAlert) {
        hasShownPermissionAlert = true;
        alert("global_seats 권한이 없습니다. Firestore Rules 배포 상태를 확인해주세요.");
      }
    }
  );

  if (stopWaitingWatch) stopWaitingWatch();
  stopWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      const data = snap.exists() ? (snap.data() || {}) : {};
      globalWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      const filtered = getCurrentTournamentWaiting();
      waitingCountEl.textContent = `WAIT: ${filtered.length}`;
      renderWaiting(filtered);
    },
    (err) => console.error("global waiting watch error:", err)
  );

  if (stopAttendanceWatch) stopAttendanceWatch();
  stopAttendanceWatch = onSnapshot(
    collection(db, "dealer_attendance"),
    (snap) => {
      attendanceWaiting = snap.docs
        .map((d) => d.data() || {})
        .filter((d) => {
          const tid = String(d.tournamentId || "").trim();
          if (tid !== tournamentId) return false;
          const status = String(d.status || "").trim();
          return status === "waiting" || status === "checked_in";
        });
      renderWaiting(getCurrentTournamentWaiting());
    },
    (err) => {
      console.error("dealer attendance watch error:", err);
    }
  );
}

backBtn?.addEventListener("click", () => {
  location.href = `./index.html?tournamentId=${encodeURIComponent(tournamentId)}`;
});

document.getElementById("metaStats")?.addEventListener("click", async (e) => {
  if (!isAdminUser || activeTab !== "seat") return;
  if (e.target.closest("#globalUndoToolbarBtn")) {
    const btn = e.target.closest("#globalUndoToolbarBtn");
    if (!lastGlobalUndo || btn?.disabled) return;
    await undoLastGlobalAction();
  }
});

panelContent?.addEventListener("click", async (e) => {
  if (!isAdminUser) return;

  if (e.target.closest("#addSeatToolbarBtn")) {
    try {
      await addGlobalSeat();
      renderSeatPanel();
    } catch (err) {
      console.error("addGlobalSeat error:", err);
      if (String(err?.code || "").includes("permission-denied")) {
        alert("좌석 생성 권한이 없습니다. Firestore Rules(global_seats) 배포를 확인해주세요.");
      } else {
        alert("좌석 생성에 실패했습니다.");
      }
    }
    return;
  }

  const addWaitBtn = e.target.closest("#addManualWaitingBtn");
  if (addWaitBtn) {
    try {
      await addManualWaiting();
    } catch (err) {
      console.error("addManualWaiting error:", err);
      alert("대기 추가에 실패했습니다.");
    }
    return;
  }

  const sortSeatOrderBtn = e.target.closest("#sortSeatOrderBtn");
  if (sortSeatOrderBtn) {
    seatSortMode = "seat";
    renderSeatPanel();
    return;
  }
  const sortSeatTimeBtn = e.target.closest("#sortSeatTimeBtn");
  if (sortSeatTimeBtn) {
    seatSortMode = "time";
    renderSeatPanel();
    return;
  }

  const renameSeatBtn = e.target.closest("[data-rename-seat]");
  if (renameSeatBtn) {
    const sid = String(renameSeatBtn.getAttribute("data-rename-seat") || "");
    if (!sid) return;
    try {
      await renameGlobalSeat(sid);
    } catch (err) {
      console.error("renameGlobalSeat error:", err);
      alert("Seat 라벨 변경에 실패했습니다.");
    }
    return;
  }

  const assignBtn = e.target.closest("[data-assign-seat]");
  if (assignBtn) {
    const sid = String(assignBtn.getAttribute("data-assign-seat") || "");
    const seat = getSeatById(sid);
    if (seat && !isEmptyPerson(String(seat.person || "").trim())) {
      alert("이미 배치된 Seat입니다.");
      return;
    }
    try {
      await assignSelectedWaitingToSeat(sid);
    } catch (err) {
      if (String(err?.message || "").includes("seat_already_occupied")) {
        alert("이미 배치된 Seat입니다. 목록을 새로 확인해주세요.");
      } else if (String(err?.message || "").includes("waiting_not_found")) {
        alert("해당 대기자가 이미 처리되었습니다.");
      } else {
        console.error("assignSelectedWaitingToSeat error:", err);
        alert("대기 배치에 실패했습니다.");
      }
    }
    return;
  }

  const deleteSeatBtn = e.target.closest("[data-delete-seat]");
  if (deleteSeatBtn) {
    const sid = String(deleteSeatBtn.getAttribute("data-delete-seat") || "");
    if (!sid) return;
    if (!confirm("이 좌석을 삭제하시겠습니까?")) return;
    try {
      await deleteGlobalSeat(sid);
      if (activeTab === "seat") renderSeatPanel();
    } catch (err) {
      console.error("deleteGlobalSeat error:", err);
      alert("좌석 삭제에 실패했습니다.");
    }
    return;
  }

  const selectSeatRow = e.target.closest("[data-select-seat]");
  if (
    selectSeatRow &&
    !e.target.closest("[data-assign-seat],[data-clear-seat],[data-delete-seat],[data-rename-seat]")
  ) {
    const sid = String(selectSeatRow.getAttribute("data-select-seat") || "");
    if (sid) {
      selectedSeatId = selectedSeatId === sid ? "" : sid;
      renderSeatPanel();
      renderSeats(globalSeats);
    }
    return;
  }

  const deleteWaitBtn = e.target.closest("[data-delete-wid]");
  if (deleteWaitBtn) {
    const widToDelete = String(deleteWaitBtn.getAttribute("data-delete-wid") || "");
    if (!widToDelete) return;
    if (!confirm("대기자를 삭제하시겠습니까?")) return;
    try {
      await removeManualWaiting(widToDelete);
      renderWaiting(getCurrentTournamentWaiting());
    } catch (err) {
      console.error("removeManualWaiting error:", err);
      alert("대기자 삭제에 실패했습니다.");
    }
    return;
  }

  const row = e.target.closest("[data-wid]");
  if (!row) return;
  const wid = String(row.getAttribute("data-wid") || "");
  if (!wid) return;
  selectedWaitingId = selectedWaitingId === wid ? "" : wid;
  if (selectedWaitingId) selectedSeatId = "";
  renderWaiting(getCurrentTournamentWaiting());
});

panelContent?.addEventListener("dblclick", async (e) => {
  if (!isAdminUser) return;
  const row = e.target.closest("[data-select-seat]");
  if (!row) return;
  const seatId = String(row.getAttribute("data-select-seat") || "").trim();
  if (!seatId) return;
  const seat = getSeatById(seatId);
  if (!seat) return;
  if (isEmptyPerson(String(seat.person || "").trim())) return;
  try {
    await clearSeat(seatId);
    renderSeats(globalSeats);
    if (activeTab === "seat") renderSeatPanel();
  } catch (err) {
    console.error("panel dblclick clearSeat error:", err);
  }
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab === "seat" ? "seat" : "wait";
    if (activeTab === "seat") {
      renderSeatPanel();
    } else {
      renderWaiting(getCurrentTournamentWaiting());
    }
  });
});

menuBtn?.addEventListener("click", () => {
  setPanelOpen(!panelOpen);
});

app?.addEventListener("pointerdown", (e) => {
  if (!isAdminUser) return;
  const box = e.target.closest(".seat-box[data-seat-id]");
  if (!box) return;
  const seatId = String(box.getAttribute("data-seat-id") || "").trim();
  if (!seatId) return;
  const canvas = app.querySelector(".pc-canvas");
  if (!canvas) return;

  const left = Number.parseFloat(box.style.left || "0") || 0;
  const top = Number.parseFloat(box.style.top || "0") || 0;
  dragState = {
    seatId,
    box,
    canvas,
    startX: e.clientX,
    startY: e.clientY,
    startLeft: left,
    startTop: top,
    moved: false
  };
  box.classList.add("selected");
  box.setPointerCapture?.(e.pointerId);
});

app?.addEventListener("pointermove", (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    dragState.moved = true;
  }
  const nextLeft = Math.max(0, dragState.startLeft + dx);
  const nextTop = Math.max(0, dragState.startTop + dy);
  dragState.box.style.left = `${Math.round(nextLeft)}px`;
  dragState.box.style.top = `${Math.round(nextTop)}px`;
});

app?.addEventListener("pointerup", async (e) => {
  if (!dragState) return;
  const current = dragState;
  current.box.classList.remove("selected");
  current.box.releasePointerCapture?.(e.pointerId);
  dragState = null;
  if (!current.moved) return;
  suppressSeatClickUntil = Date.now() + 220;
  const left = Number.parseFloat(current.box.style.left || "0") || 0;
  const top = Number.parseFloat(current.box.style.top || "0") || 0;
  try {
    await saveSeatPosition(current.seatId, left, top);
  } catch (err) {
    console.error("saveSeatPosition error:", err);
  }
});

app?.addEventListener("pointercancel", () => {
  if (!dragState) return;
  dragState.box.classList.remove("selected");
  dragState = null;
});

app?.addEventListener("click", async (e) => {
  if (!isAdminUser) return;
  const box = e.target.closest(".seat-box[data-seat-id]");
  if (!box) return;
  if (Date.now() < suppressSeatClickUntil) return;

  const seatId = String(box.getAttribute("data-seat-id") || "").trim();
  if (!seatId) return;
  const seat = getSeatById(seatId);
  if (!seat) return;

  if (e.detail >= 2 && !selectedWaitingId) {
    if (!isEmptyPerson(String(seat.person || "").trim())) {
      try {
        await clearSeat(seatId);
        renderSeats(globalSeats);
        if (activeTab === "seat") renderSeatPanel();
      } catch (err) {
        console.error("click detail clearSeat error:", err);
      }
    }
    return;
  }

  if (selectedWaitingId) {
    if (!isEmptyPerson(String(seat.person || "").trim())) {
      alert("이미 배치된 Seat입니다.");
      return;
    }
    try {
      await assignSelectedWaitingToSeat(seatId);
      renderWaiting(getCurrentTournamentWaiting());
      if (activeTab === "seat") renderSeatPanel();
    } catch (err) {
      if (String(err?.message || "").includes("seat_already_occupied")) {
        alert("이미 배치된 Seat입니다.");
      } else if (String(err?.message || "").includes("waiting_not_found")) {
        alert("해당 대기자가 이미 처리되었습니다.");
      } else {
        console.error("canvas assignSelectedWaitingToSeat error:", err);
        alert("대기 배치에 실패했습니다.");
      }
    }
    return;
  }

  selectedSeatId = selectedSeatId === seatId ? "" : seatId;
  renderSeats(globalSeats);
  if (activeTab === "seat") renderSeatPanel();
});

window.addEventListener("keydown", async (e) => {
  if (!isAdminUser) return;
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (activeTab === "wait" && selectedWaitingId) {
    try {
      await removeManualWaiting(selectedWaitingId);
      renderWaiting(getCurrentTournamentWaiting());
    } catch (err) {
      console.error("keyboard removeManualWaiting error:", err);
    }
    return;
  }
  if (selectedSeatId) {
    try {
      await deleteGlobalSeat(selectedSeatId);
      renderSeats(globalSeats);
      if (activeTab === "seat") renderSeatPanel();
    } catch (err) {
      console.error("keyboard deleteGlobalSeat error:", err);
    }
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("./login.html");
    return;
  }

  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    const profile = userSnap.exists() ? (userSnap.data() || {}) : null;
    isAdminUser = getIsAdmin(user, profile);
    if (!isAdminUser) {
      alert("관리자만 접근할 수 있습니다.");
      location.replace("./index.html");
      return;
    }
    if (urlEventId && urlBoxId) {
      sessionStorage.setItem("eventId", urlEventId);
      sessionStorage.setItem("boxId", urlBoxId);
    }
    setPanelOpen(false);
    bindRealtime();
    updateGlobalMetaToolbar();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      if (isTypingInPanel()) return;
      updateCanvasSeatTimerClasses();
      if (activeTab === "seat") {
        renderSeatPanel();
      } else {
        renderWaiting(getCurrentTournamentWaiting());
      }
    }, 1000);
  } catch (err) {
    console.error("global layout init error:", err);
    alert("통합 배치도를 불러오지 못했습니다.");
  }
});
