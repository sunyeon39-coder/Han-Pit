import { db } from "../firebase.js";
import {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { GL } from "./state.js";
import {
  buildGlobalSeatDocId,
  getAttendanceRef,
  getProjectionDocId,
  parseGlobalSeatDocId,
  resolveSeatEventBox,
  resolveGlobalSeatFirestoreDoc,
  ensureGlobalSeatFirestoreDoc,
  listGlobalSeatDocRefsBySeatId,
  isEmptyPerson,
  isValidLayoutRouteIdPart,
  isValidSeatLabel,
  looksLikeDisplayTitleNotId,
  makeUid
} from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import {
  getDefaultEventBoxForNewSeat,
  getSeatById,
  renderSeatPanel,
  renderSeats
} from "./panel-ui.js";
import {
  resolveTournamentEventCardId,
  syncLayoutProjection,
  ensureLayoutEventShellForGlobalOps,
  validateLayoutEventForGlobalOps
} from "./fs-layout-projection.js";
import {
  fetchEventCardsForSeatEdit,
  resolveEventIdForSave
} from "./tournament-events.js";
import { syncSeatAddEventPickerFromHidden } from "./seat-add-event-picker.js";
import { writePersistedSeatAddForm } from "./seat-add-form-persist.js";
import { pushGlobalUndo } from "./undo-stack.js";
import { flushOptimisticGlobalLayoutUi } from "./optimistic-seat-mutation.js";

/** 멀티 선택된 좌석을 같은 y(가로 일렬) 또는 같은 x(세로 일렬)로 맞춥니다. */
export async function alignSelectedGlobalSeats(axis = "") {
  const ax = String(axis || "").trim();
  if (ax !== "row" && ax !== "col") return;
  if (!GL.isAdminUser) return;
  const ids = [...GL.selectedSeatIds];
  if (ids.length < 2) return;

  const seats = ids.map((id) => getSeatById(id)).filter(Boolean);
  if (seats.length < 2) return;

  const isRow = ax === "row";
  let sum = 0;
  for (const s of seats) {
    sum += isRow ? Number(s.y) || 0 : Number(s.x) || 0;
  }
  const aligned = Math.round(sum / seats.length);

  const updates = seats.map((s) => {
    const sid = String(s.seatId || "").trim();
    const x = isRow
      ? (Number.isFinite(Number(s.x)) ? Math.round(Number(s.x)) : 0)
      : aligned;
    const y = isRow
      ? aligned
      : (Number.isFinite(Number(s.y)) ? Math.round(Number(s.y)) : 0);
    return { sid, x, y };
  });

  for (const u of updates) {
    const s = getSeatById(u.sid);
    if (s) {
      s.x = u.x;
      s.y = u.y;
    }
  }
  renderSeats(GL.globalSeats);
  if (GL.activeTab === "seat") renderSeatPanel();

  try {
    await Promise.all(updates.map((u) => saveSeatPosition(u.sid, u.x, u.y)));
  } catch (err) {
    console.error("alignSelectedGlobalSeats error:", err);
    alert("정렬 저장에 실패했습니다.");
  }
}

export async function saveSeatPosition(seatId = "", x = 0, y = 0) {
  const seat = getSeatById(seatId);
  if (!seat) return;
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return;
  const docId = buildGlobalSeatDocId(eventId, boxId, seatId);
  await setDoc(
    doc(db, "tournaments", GL.tournamentId, "global_seats", docId),
    {
      x: Math.max(0, Math.round(Number(x) || 0)),
      y: Math.max(0, Math.round(Number(y) || 0)),
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

export async function deleteGlobalSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId) return;
  const seat = getSeatById(targetSeatId);
  if (!seat) return;
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return;
  const ref = doc(db, "tournaments", GL.tournamentId, "global_seats", buildGlobalSeatDocId(eventId, boxId, targetSeatId));
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const seatDoc = snap.data() || {};
  await deleteDoc(ref);
  GL.selectedSeatIds.delete(targetSeatId);
  pushGlobalUndo({ kind: "delete_seat", seatId: targetSeatId, eventId, boxId, seatDoc });
  await syncLayoutProjection(eventId, boxId);
}

async function clearDuplicatePersonSeatsExcept(
  person = {},
  excludeSeatId = "",
  now = Date.now()
) {
  const refs = getCandidateSeatRefsForPerson(
    db,
    GL.tournamentId,
    GL.globalSeats,
    person,
    excludeSeatId
  );
  const touched = new Set();

  for (const ref of refs) {
    let snap;
    try {
      snap = await getDoc(ref);
    } catch (err) {
      console.warn("clearDuplicatePersonSeatsExcept getDoc:", err);
      continue;
    }
    if (!snap.exists()) continue;
    const data = snap.data() || {};
    const otherSeatId = String(data.seatId || "").trim();
    const kEvent = String(data.currentEventId || data.mappedEventId || "").trim();
    const kBox = String(data.boxId || "").trim();
    if (kEvent && kBox) touched.add(`${kEvent}__${kBox}`);

    await setDoc(
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

    if (otherSeatId) {
      const oidx = GL.globalSeats.findIndex(
        (s) => String(s.seatId || "").trim() === otherSeatId
      );
      if (oidx >= 0) {
        GL.globalSeats[oidx] = {
          ...GL.globalSeats[oidx],
          person: "비어있음",
          personUid: "",
          personEmail: "",
          seatedAt: null,
          status: "empty"
        };
      }
    }
  }

  return touched;
}

async function deleteOrphanGlobalSeatDocsForSeatId(seatId = "", keepDocId = "") {
  const keep = String(keepDocId || "").trim();
  const rows = await listGlobalSeatDocRefsBySeatId(GL.tournamentId, seatId);
  for (const row of rows) {
    if (keep && row.id === keep) continue;
    try {
      await deleteDoc(row.ref);
    } catch (err) {
      console.error("deleteOrphanGlobalSeatDocsForSeatId error:", err);
    }
  }
}

function seatCardPairDiffers(prevE, prevB, nextE, nextB, eventCards = []) {
  const pe = resolveEventIdForSave(prevE, eventCards) || String(prevE || "").trim();
  const ne = resolveEventIdForSave(nextE, eventCards) || String(nextE || "").trim();
  const pb = String(prevB || "").trim() || "1";
  const nb = String(nextB || "").trim() || "1";
  if (pe !== ne) return true;
  if (pb !== nb) return true;
  if (String(prevE || "").trim() !== String(nextE || "").trim()) return true;
  return false;
}

/** Firestore global_seats 문서 — doc id·seatId 쿼리·로컬 복구 */
async function findGlobalSeatDocRef(seatId = "", eventCards = []) {
  const sid = String(seatId || "").trim();
  if (!sid || !GL.tournamentId) return null;

  const seat = getSeatById(sid);
  const pairs = [];
  if (seat) {
    pairs.push(resolveSeatEventBox(seat));
  }
  for (const s of GL.globalSeats || []) {
    if (String(s.seatId || "").trim() !== sid) continue;
    pairs.push(resolveSeatEventBox(s));
  }

  let resolved =
    (await resolveGlobalSeatFirestoreDoc(seat || { seatId: sid }, GL.tournamentId, pairs)) ||
    (await ensureGlobalSeatFirestoreDoc(seat || { seatId: sid }, GL.tournamentId, pairs));

  if (!resolved?.snap?.exists()) return null;

  const data = resolved.data || {};
  const parsed = parseGlobalSeatDocId(resolved.docId, sid);
  const rawE = String(seat?.currentEventId || seat?.mappedEventId || "").trim();
  const eventId =
    String(data.currentEventId || data.mappedEventId || parsed?.eventId || "").trim() ||
    resolveEventIdForSave(rawE, eventCards) ||
    rawE;
  const boxId = String(data.boxId || parsed?.boxId || "").trim() || "1";

  if (seat && resolved.docId) {
    const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === sid);
    if (idx >= 0) {
      GL.globalSeats[idx] = {
        ...GL.globalSeats[idx],
        __firestoreDocId: resolved.docId,
        currentEventId: eventId,
        mappedEventId: eventId,
        boxId
      };
    }
  }

  return {
    ref: resolved.ref,
    snap: resolved.snap,
    eventId,
    boxId
  };
}

/**
 * Seat 라벨·카드 ID(eventId)·Box ID 변경 (모달 등에서 호출)
 * @returns {Promise<{ ok: boolean, shouldOfferLayout?: { eventId: string, boxId: string } | null }>}
 */
export async function applyGlobalSeatRename(
  targetSeatIdIn = "",
  nextLabelIn = "",
  nextEventIdIn = "",
  nextBoxIdIn = ""
) {
  const targetSeatId = String(targetSeatIdIn || "").trim();
  const nextLabel = String(nextLabelIn || "").trim();
  const nextEventId = String(nextEventIdIn || "").trim();
  const nextBoxId = String(nextBoxIdIn || "").trim();

  if (!targetSeatId) return { ok: false };

  if (!nextLabel) {
    alert("Seat 라벨은 비울 수 없습니다.");
    return { ok: false };
  }
  if (!isValidSeatLabel(nextLabel)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return { ok: false };
  }
  if (!nextEventId || !nextBoxId) {
    alert("카드 ID(eventId)와 Box ID를 모두 입력해주세요.");
    return { ok: false };
  }

  if (!isValidLayoutRouteIdPart(nextEventId) || !isValidLayoutRouteIdPart(nextBoxId)) {
    alert(
      "카드 ID / Box ID 형식이 올바르지 않습니다. (비어 있지 않고, / 나 __ 는 사용할 수 없습니다.)\nindex「카드 관리」·layout 주소창의 eventId·boxId를 확인하세요."
    );
    return { ok: false };
  }
  const seat = getSeatById(targetSeatId);
  if (!seat) {
    alert("Seat를 찾을 수 없습니다.");
    return { ok: false };
  }

  let eventCards = [];
  try {
    eventCards = await fetchEventCardsForSeatEdit();
  } catch (err) {
    console.error("fetchEventCardsForSeatEdit error:", err);
  }

  const resolvedNextEventId = resolveEventIdForSave(nextEventId, eventCards) || nextEventId;
  const knownCard = eventCards.some((ev) => String(ev?.id || "").trim() === resolvedNextEventId);
  if (!knownCard && looksLikeDisplayTitleNotId(resolvedNextEventId)) {
    alert(
      "카드는 목록에서 선택해 주세요.\nindex「카드 관리」에 등록된 카드만 사용할 수 있습니다."
    );
    return { ok: false };
  }

  const foundDoc = await findGlobalSeatDocRef(targetSeatId, eventCards);
  if (!foundDoc?.snap?.exists()) {
    alert("Firestore에서 이 Seat 문서를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.");
    return { ok: false };
  }

  const prevEventId = foundDoc.eventId;
  const prevBoxId = foundDoc.boxId;
  const rawSeatEvent = String(seat.currentEventId || seat.mappedEventId || "").trim();

  const prevLabel = String(seat.label ?? seat.no ?? "").trim();
  const moved = seatCardPairDiffers(
    prevEventId || rawSeatEvent,
    prevBoxId,
    resolvedNextEventId,
    nextBoxId,
    eventCards
  );
  if (!moved && nextLabel === prevLabel) {
    alert("변경된 내용이 없습니다. 다른 카드를 선택했는지 확인해 주세요.");
    return { ok: false };
  }

  const oldRef = foundDoc.ref;
  const newDocId = buildGlobalSeatDocId(resolvedNextEventId, nextBoxId, targetSeatId);
  const newRef = doc(db, "tournaments", GL.tournamentId, "global_seats", newDocId);
  const now = Date.now();

  if (!moved) {
    await setDoc(
      oldRef,
      {
        label: nextLabel,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    const idxLabel = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
    if (idxLabel >= 0) GL.globalSeats[idxLabel] = { ...GL.globalSeats[idxLabel], label: nextLabel };
    if (GL.activeTab === "seat") renderSeatPanel();
    renderSeats(GL.globalSeats);
    await syncLayoutProjection(resolvedNextEventId, nextBoxId);
    return { ok: true, shouldOfferLayout: null };
  }

  await ensureLayoutEventShellForGlobalOps(resolvedNextEventId, nextBoxId);
  if (prevEventId !== resolvedNextEventId || prevBoxId !== nextBoxId) {
    await ensureLayoutEventShellForGlobalOps(prevEventId, prevBoxId);
  }

  const syncPrevParsed =
    parseGlobalSeatDocId(foundDoc.ref.id, targetSeatId) || {
      eventId: prevEventId,
      boxId: prevBoxId
    };

  if (moved) {
    const oldDocId = foundDoc.ref.id;
    if (oldDocId === newDocId) {
      await setDoc(
        oldRef,
        {
          label: nextLabel,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } else {
      const newSnap = await getDoc(newRef);
      if (newSnap.exists()) {
        alert(
          `대상 카드(${nextEventId}) / Box(${nextBoxId})에 이미 같은 Seat ID(${targetSeatId})가 있습니다.\n` +
            `대기 중인 문서를 정리하거나 다른 Seat ID를 쓰는 배치도를 선택해 주세요.`
        );
        return { ok: false };
      }
      const oldSnap = foundDoc?.snap || (await getDoc(oldRef));
      if (!oldSnap.exists()) {
        alert("원본 Seat 문서를 찾을 수 없습니다.");
        return { ok: false };
      }
      const base = oldSnap.data() || {};
      await setDoc(
        newRef,
        {
          ...base,
          seatId: targetSeatId,
          label: nextLabel,
          mappedEventId: resolvedNextEventId,
          currentEventId: resolvedNextEventId,
          boxId: nextBoxId,
          sourceLayoutDocId: getProjectionDocId(resolvedNextEventId, nextBoxId),
          tournamentId: GL.tournamentId,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
      await deleteOrphanGlobalSeatDocsForSeatId(targetSeatId, newDocId);
    }
  }

  const personName = String(seat.person || "").trim();
  const projectionKeys = new Set();
  if (moved && !isEmptyPerson(personName)) {
    const dupKeys = await clearDuplicatePersonSeatsExcept(
      {
        uid: String(seat.personUid || "").trim(),
        email: String(seat.personEmail || "").trim(),
        name: personName
      },
      targetSeatId,
      now
    );
    dupKeys.forEach((k) => projectionKeys.add(k));
  }

  const uid = String(seat.personUid || "").trim();
  if (uid) {
    const eventCardLabel = await resolveTournamentEventCardId(resolvedNextEventId);
    await setDoc(
      getAttendanceRef(db, GL.tournamentId, uid),
      {
        uid,
        tournamentId: GL.tournamentId,
        currentSeatLabel: nextLabel,
        currentEventId: resolvedNextEventId,
        currentBoxId: nextBoxId,
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
        tournamentId: GL.tournamentId,
        eventId: resolvedNextEventId,
        eventTitle: eventCardLabel,
        boxId: nextBoxId,
        seatId: targetSeatId,
        seatLabel: nextLabel,
        targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(resolvedNextEventId)}&boxId=${encodeURIComponent(nextBoxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`,
        message: `${eventCardLabel} / Seat ${nextLabel} ${
          moved ? "배치(카드·Box)가 변경되었습니다." : "라벨이 변경되었습니다."
        }`,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  }

  const oldDocId = foundDoc.ref.id;
  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
  const updatedSeat = {
    ...(idx >= 0 ? GL.globalSeats[idx] : seat),
    seatId: targetSeatId,
    label: nextLabel,
    currentEventId: resolvedNextEventId,
    mappedEventId: resolvedNextEventId,
    boxId: nextBoxId,
    sourceLayoutDocId: getProjectionDocId(resolvedNextEventId, nextBoxId),
    __firestoreDocId: moved && oldDocId !== newDocId ? newDocId : foundDoc.ref.id
  };
  if (idx >= 0) {
    GL.globalSeats[idx] = updatedSeat;
  }
  GL.globalSeats = GL.globalSeats.filter((s, i, arr) => {
    const sid = String(s.seatId || "").trim();
    if (sid !== targetSeatId) return true;
    const eid = String(s.currentEventId || s.mappedEventId || "").trim();
    const bx = String(s.boxId || "").trim();
    const isCanonical =
      eid === resolvedNextEventId && bx === nextBoxId;
    if (!isCanonical) return false;
    const firstCanon = arr.findIndex((x) => {
      if (String(x.seatId || "").trim() !== sid) return false;
      const xe = String(x.currentEventId || x.mappedEventId || "").trim();
      const xb = String(x.boxId || "").trim();
      return xe === resolvedNextEventId && xb === nextBoxId;
    });
    return i === firstCanon;
  });

  if (moved && oldDocId !== newDocId) {
    projectionKeys.add(`${syncPrevParsed.eventId}__${syncPrevParsed.boxId}`);
    projectionKeys.add(`${resolvedNextEventId}__${nextBoxId}`);
  } else {
    projectionKeys.add(`${resolvedNextEventId}__${nextBoxId}`);
  }
  for (const key of projectionKeys) {
    const sep = key.lastIndexOf("__");
    if (sep < 0) continue;
    const e = key.slice(0, sep).trim();
    const b = key.slice(sep + 2).trim();
    if (e && b) await syncLayoutProjection(e, b);
  }

  if (GL.activeTab === "seat") renderSeatPanel();
  renderSeats(GL.globalSeats);

  const shouldOfferLayout =
    moved && oldDocId !== newDocId
      ? { eventId: resolvedNextEventId, boxId: nextBoxId }
      : null;

  return { ok: true, shouldOfferLayout };
}

export async function addGlobalSeatQuick(rawLabel = "") {
  const label = String(rawLabel || "").trim();
  if (!label) {
    alert("Seat 라벨을 입력하세요.");
    return;
  }
  const fallbackEb = getDefaultEventBoxForNewSeat();
  await addGlobalSeatCore({
    label,
    eventId: fallbackEb.eventId,
    boxId: fallbackEb.boxId,
    clearFormInputs: false
  });
}

export async function addGlobalSeat() {
  const seatLabelInput = document.getElementById("seatLabelInput");
  const seatEventInput = document.getElementById("seatEventInput");
  const seatBoxInput = document.getElementById("seatBoxInput");
  const label = String(seatLabelInput?.value || "").trim();
  const fallbackEb = getDefaultEventBoxForNewSeat();
  const eventId = String(seatEventInput?.value || "").trim() || fallbackEb.eventId;
  const boxId = String(seatBoxInput?.value || "").trim() || fallbackEb.boxId;
  await addGlobalSeatCore({
    label,
    eventId,
    boxId,
    clearFormInputs: true
  });
}

/** 모바일 Seat 추가 모달 등 — DOM 없이 카드·Box 지정 */
export async function addGlobalSeatFromValues({ label = "", eventId = "", boxId = "" } = {}) {
  await addGlobalSeatCore({
    label,
    eventId,
    boxId,
    clearFormInputs: false
  });
}

async function addGlobalSeatCore({ label = "", eventId = "", boxId = "", clearFormInputs = false } = {}) {
  const lid = String(label || "").trim();
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!lid) {
    alert("Seat 라벨을 입력하세요.");
    return;
  }
  if (!eid || !bid) {
    alert("eventId와 boxId를 입력하거나, index에서 이벤트 카드를 선택한 뒤 다시 시도하세요.");
    return;
  }
  if (!isValidLayoutRouteIdPart(eid) || !isValidLayoutRouteIdPart(bid)) {
    alert(
      "카드 ID / Box ID 형식이 올바르지 않습니다. (비어 있지 않고, / 나 __ 는 사용할 수 없습니다.)\nindex「카드 관리」에 표시된 값과 layout.html 주소창의 eventId·boxId를 확인하세요."
    );
    return;
  }
  if (looksLikeDisplayTitleNotId(eid)) {
    alert(
      "EVENT 칸에는 카드 제목이 아니라 카드 ID(예: 숫자·event_1)를 넣어야 합니다.\nindex「카드 관리」에서 해당 카드를 선택하면 카드 ID·Box ID가 보입니다."
    );
    return;
  }

  await ensureLayoutEventShellForGlobalOps(eid, bid);
  const layoutGate = await validateLayoutEventForGlobalOps(eid, bid, {
    ensureShell: true,
    trustGlobalSeats: true
  });
  if (!layoutGate.ok) {
    alert(layoutGate.message);
    return;
  }

  if (!isValidSeatLabel(lid)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return;
  }

  const now = Date.now();
  const seatId = `seat_${makeUid("g").slice(-8)}`;
  const order = GL.globalSeats.length + 1;
  const docId = buildGlobalSeatDocId(eid, bid, seatId);

  const optimistic = {
    seatId,
    label: lid,
    no: order,
    order,
    x: 0,
    y: 0,
    person: "비어있음",
    personUid: "",
    personEmail: "",
    seatedAt: null,
    status: "empty",
    tournamentId: GL.tournamentId,
    mappedEventId: eid,
    currentEventId: eid,
    boxId: bid,
    sourceLayoutDocId: `${eid}__${bid}`,
    __firestoreDocId: docId
  };
  const existingIdx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === seatId);
  if (existingIdx >= 0) GL.globalSeats[existingIdx] = { ...GL.globalSeats[existingIdx], ...optimistic };
  else GL.globalSeats.push(optimistic);
  flushOptimisticGlobalLayoutUi();

  try {
    await setDoc(
      doc(db, "tournaments", GL.tournamentId, "global_seats", docId),
      {
        seatId,
        label: lid,
        no: order,
        order,
        x: 0,
        y: 0,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty",
        tournamentId: GL.tournamentId,
        mappedEventId: eid,
        currentEventId: eid,
        boxId: bid,
        sourceLayoutDocId: `${eid}__${bid}`,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    await syncLayoutProjection(eid, bid);
    sessionStorage.setItem("eventId", eid);
    sessionStorage.setItem("boxId", bid);
    pushGlobalUndo({ kind: "add_seat", seatId, eventId: eid, boxId: bid });
  } catch (err) {
    const rollbackIdx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === seatId);
    if (rollbackIdx >= 0) GL.globalSeats.splice(rollbackIdx, 1);
    flushOptimisticGlobalLayoutUi();
    throw err;
  }

  if (clearFormInputs) {
    const seatLabelInput = document.getElementById("seatLabelInput");
    const seatEventInput = document.getElementById("seatEventInput");
    const seatBoxInput = document.getElementById("seatBoxInput");
    if (seatLabelInput) seatLabelInput.value = "";
    if (seatEventInput) seatEventInput.value = eid;
    if (seatBoxInput) seatBoxInput.value = bid;
    writePersistedSeatAddForm(eid, bid);
    syncSeatAddEventPickerFromHidden();
  }
}
