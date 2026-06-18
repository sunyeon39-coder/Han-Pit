import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { GL } from "./state.js";
import { getProjectionDocId, isEmptyPerson } from "./utils.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";

const tournamentEventTitleCache = new Map();

export async function resolveTournamentEventTitle(eventId = "") {
  const eid = String(eventId || "").trim();
  if (!eid || !GL.tournamentId) return eid || "이벤트";
  const key = `${GL.tournamentId}\t${eid}`;
  if (tournamentEventTitleCache.has(key)) return tournamentEventTitleCache.get(key);
  try {
    const snap = await getDoc(doc(db, "tournaments", GL.tournamentId, "events", eid));
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

/** 배치 알림용 — tournaments/.../events 의 cardId (없으면 문서 ID에서 파싱). */
export async function resolveTournamentEventCardId(eventId = "") {
  const eid = String(eventId || "").trim();
  const fallback = getEventCardIdFromRecord({ id: eid }) || eid || "이벤트";
  if (!eid || !GL.tournamentId) return fallback;
  const key = `${GL.tournamentId}\tcard\t${eid}`;
  if (tournamentEventTitleCache.has(key)) return tournamentEventTitleCache.get(key);
  try {
    const snap = await getDoc(doc(db, "tournaments", GL.tournamentId, "events", eid));
    const data = snap.exists() ? snap.data() || {} : {};
    const label = getEventCardIdFromRecord({ id: eid, cardId: data.cardId }) || fallback;
    tournamentEventTitleCache.set(key, label);
    return label;
  } catch (err) {
    console.error("resolveTournamentEventCardId error:", err);
    tournamentEventTitleCache.set(key, fallback);
    return fallback;
  }
}

export function hasGlobalSeatForEventBox(eventId = "", boxId = "", seatId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  const sid = String(seatId || "").trim();
  if (!e || !b) return false;
  return GL.globalSeats.some((s) => {
    const eid = String(s.currentEventId || s.mappedEventId || "").trim();
    const bx = String(s.boxId || "").trim();
    const matchEb = eid === e && bx === b;
    if (!matchEb) return false;
    if (!sid) return true;
    return String(s.seatId || "").trim() === sid;
  });
}

function isSeatInLayoutEventDoc(data = {}, seatId = "") {
  const sid = String(seatId || "").trim();
  if (!sid) return false;
  const seats = Array.isArray(data.seats) ? data.seats : [];
  return seats.some((s) => {
    const id = String(s?.id || s?.seatId || "").trim();
    return id === sid;
  });
}

async function eventExistsInCurrentTournament(eventId = "") {
  const eid = String(eventId || "").trim();
  if (!eid || !GL.tournamentId) return false;
  try {
    const snap = await getDoc(doc(db, "tournaments", GL.tournamentId, "events", eid));
    return snap.exists();
  } catch (err) {
    console.warn("eventExistsInCurrentTournament:", err?.code || err);
    return false;
  }
}

/** layout_events 키(event__box)는 대회 간 공유될 수 있음 — 현재 대회 문맥이면 tournamentId 갱신 */
async function reconcileLayoutEventTournamentId(ref, data = {}, eventId = "", boxId = "") {
  const docTid = String(data.tournamentId || "").trim();
  if (!GL.tournamentId || !docTid || docTid === GL.tournamentId) return true;

  const canReassign =
    hasGlobalSeatForEventBox(eventId, boxId) ||
    (await eventExistsInCurrentTournament(eventId));

  if (!canReassign) return false;

  try {
    await setDoc(
      ref,
      {
        tournamentId: GL.tournamentId,
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.error("reconcileLayoutEventTournamentId error:", err);
    return false;
  }
}

/** layout_events 스텁이 없거나 nextSeatNo가 비어 있을 때 통합 배치도 작업이 막히지 않도록 보장 */
export async function ensureLayoutEventShellForGlobalOps(eventId = "", boxId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b || !GL.tournamentId) return;

  const ref = doc(db, "layout_events", getProjectionDocId(e, b));
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    console.error("ensureLayoutEventShellForGlobalOps getDoc error:", err);
    return;
  }

  const data = snap.exists() ? snap.data() || {} : {};
  const hasNextNo = typeof data.nextSeatNo === "number" && Number.isFinite(data.nextSeatNo);
  const hasNextOrder = typeof data.nextSeatOrder === "number" && Number.isFinite(data.nextSeatOrder);
  const seats = Array.isArray(data.seats) ? data.seats : [];

  if (snap.exists() && hasNextNo && hasNextOrder) {
    const docTid = String(data.tournamentId || "").trim();
    if (GL.tournamentId && docTid && docTid !== GL.tournamentId) {
      const ok = await reconcileLayoutEventTournamentId(ref, data, e, b);
      if (!ok) return;
    } else if (!docTid) {
      try {
        await setDoc(
          ref,
          { tournamentId: GL.tournamentId, updatedAt: Date.now(), updatedAtServer: serverTimestamp() },
          { merge: true }
        );
      } catch (err) {
        console.error("ensureLayoutEventShellForGlobalOps patch tournamentId error:", err);
      }
    }
    return;
  }

  try {
    await setDoc(
      ref,
      {
        version: 2,
        tournamentId: GL.tournamentId,
        eventId: e,
        boxId: b,
        nextSeatNo: hasNextNo ? data.nextSeatNo : 1,
        nextSeatOrder: hasNextOrder ? data.nextSeatOrder : 1,
        seats,
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.error("ensureLayoutEventShellForGlobalOps setDoc error:", err);
  }
}

export async function validateLayoutEventForGlobalOps(eventId = "", boxId = "", opts = {}) {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b) {
    return { ok: false, message: "eventId와 boxId가 필요합니다." };
  }

  const requireSeatId = String(opts.requireSeatId || "").trim();
  const trustGlobalSeats = opts.trustGlobalSeats !== false;

  if (opts.allowSeatMigration) {
    await ensureLayoutEventShellForGlobalOps(e, b);
    return { ok: true };
  }

  if (opts.ensureShell) {
    await ensureLayoutEventShellForGlobalOps(e, b);
  }

  let snap;
  try {
    snap = await getDoc(doc(db, "layout_events", getProjectionDocId(e, b)));
  } catch (err) {
    console.error("validateLayoutEventForGlobalOps getDoc error:", err);
    return { ok: false, message: "layout_events 확인 중 오류가 났습니다." };
  }

  if (!snap.exists()) {
    if (trustGlobalSeats && hasGlobalSeatForEventBox(e, b, requireSeatId || "")) {
      await ensureLayoutEventShellForGlobalOps(e, b);
      return { ok: true };
    }
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout_events에 없습니다.\n\n※ index「카드 관리」에서 이 카드 ID·Box ID로 카드를 저장하면 자동으로 생성됩니다. 값이 카드와 다르지 않은지 확인하거나, layout.html에서 한 번 저장해 주세요.`
    };
  }

  const data = snap.data() || {};
  const docTid = String(data.tournamentId || "").trim();
  if (docTid && GL.tournamentId && docTid !== GL.tournamentId) {
    const ref = doc(db, "layout_events", getProjectionDocId(e, b));
    const reconciled = await reconcileLayoutEventTournamentId(ref, data, e, b);
    if (!reconciled) {
      return { ok: false, message: "이 event/box는 현재 대회와 연결되어 있지 않습니다." };
    }
  }

  const hasNextNo = typeof data.nextSeatNo === "number" && Number.isFinite(data.nextSeatNo);
  const hasNextOrder = typeof data.nextSeatOrder === "number" && Number.isFinite(data.nextSeatOrder);
  if (!hasNextNo && !hasNextOrder) {
    if (trustGlobalSeats && hasGlobalSeatForEventBox(e, b)) {
      await ensureLayoutEventShellForGlobalOps(e, b);
      return { ok: true };
    }
    return {
      ok: false,
      message: `event ${e} / box ${b} 는 layout에서 저장된 구성이 아닙니다. index·layout에서 실제 박스를 연 뒤 저장해 주세요.`
    };
  }

  if (requireSeatId) {
    const inLayoutDoc = isSeatInLayoutEventDoc(data, requireSeatId);
    const inGlobal = trustGlobalSeats && hasGlobalSeatForEventBox(e, b, requireSeatId);
    if (!inLayoutDoc && !inGlobal) {
      return {
        ok: false,
        message: "이 Seat은 배치도에 등록된 좌석이 아닙니다. 잠시 후 다시 시도하거나, layout에서 해당 Seat이 있는지 확인하세요."
      };
    }
  }

  return { ok: true };
}

export async function syncLayoutProjection(eventId = "", boxId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b || !GL.tournamentId) return;

  const layoutDocId = getProjectionDocId(e, b);
  let liveRows = (GL.globalSeats || []).filter((s) => {
    const src = String(s.sourceLayoutDocId || "").trim();
    if (src && src === layoutDocId) return true;
    const eid = String(s.currentEventId || s.mappedEventId || "").trim();
    return eid === e && String(s.boxId || "").trim() === b;
  });
  if (!liveRows.length) {
    try {
      const q = query(
        collection(db, "tournaments", GL.tournamentId, "global_seats"),
        where("sourceLayoutDocId", "==", layoutDocId)
      );
      const snap = await getDocs(q);
      liveRows = snap.docs.map((d) => d.data() || {});
    } catch (err) {
      console.error("syncLayoutProjection getDocs error:", err);
    }
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
      tournamentId: GL.tournamentId,
      eventId: e,
      boxId: b,
      seats,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

const projectionSyncTimers = new Map();

/** 배치·비우기 직후 UI는 리스너에 맡기고 layout_events 동기화만 짧게 묶음 */
export function scheduleSyncLayoutProjection(eventId = "", boxId = "") {
  const e = String(eventId || "").trim();
  const b = String(boxId || "").trim();
  if (!e || !b) return;
  const key = `${e}__${b}`;
  const prev = projectionSyncTimers.get(key);
  if (prev) clearTimeout(prev);
  projectionSyncTimers.set(
    key,
    setTimeout(() => {
      projectionSyncTimers.delete(key);
      void syncLayoutProjection(e, b).catch((err) => {
        console.error("scheduleSyncLayoutProjection error:", err);
      });
    }, 120)
  );
}
