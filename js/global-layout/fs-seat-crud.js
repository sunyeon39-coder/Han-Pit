import { db } from "../firebase.js";
import {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";
import {
  buildGlobalSeatDocId,
  getAttendanceRef,
  getProjectionDocId,
  parseGlobalSeatDocId,
  isValidLayoutRouteIdPart,
  isValidSeatLabel,
  looksLikeDisplayTitleNotId,
  makeUid
} from "./utils.js";
import {
  getDefaultEventBoxForNewSeat,
  getSeatById,
  renderSeatPanel,
  renderSeats
} from "./panel-ui.js";
import {
  resolveTournamentEventTitle,
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
  GL.lastGlobalUndo = { kind: "delete_seat", seatId: targetSeatId, eventId, boxId, seatDoc };
  await syncLayoutProjection(eventId, boxId);
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

/** Firestore global_seats 문서 — 실제 doc id 우선, seatId 기준 fallback */
async function findGlobalSeatDocRef(seatId = "", eventCards = []) {
  const sid = String(seatId || "").trim();
  if (!sid || !GL.tournamentId) return null;

  const seat = getSeatById(sid);
  const docIdFromSnap = String(seat?.__firestoreDocId || "").trim();
  if (docIdFromSnap) {
    const ref = doc(db, "tournaments", GL.tournamentId, "global_seats", docIdFromSnap);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() || {};
      const parsed = parseGlobalSeatDocId(docIdFromSnap, sid);
      return {
        ref,
        snap,
        eventId: String(data.currentEventId || data.mappedEventId || parsed?.eventId || "").trim(),
        boxId: String(data.boxId || parsed?.boxId || "").trim() || "1"
      };
    }
  }

  const pairs = [];
  if (seat) {
    pairs.push([
      String(seat.currentEventId || seat.mappedEventId || "").trim(),
      String(seat.boxId || "").trim()
    ]);
  }
  for (const s of GL.globalSeats || []) {
    if (String(s.seatId || "").trim() !== sid) continue;
    pairs.push([
      String(s.currentEventId || s.mappedEventId || "").trim(),
      String(s.boxId || "").trim()
    ]);
  }

  const seen = new Set();
  for (const [rawE, rawB] of pairs) {
    const b = String(rawB || "").trim() || "1";
    const tryEvents = [String(rawE || "").trim(), resolveEventIdForSave(rawE, eventCards) || ""].filter(Boolean);
    for (const e of tryEvents) {
      const key = `${e}\t${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = doc(
        db,
        "tournaments",
        GL.tournamentId,
        "global_seats",
        buildGlobalSeatDocId(e, b, sid)
      );
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() || {};
        return {
          ref,
          snap,
          eventId: String(data.currentEventId || data.mappedEventId || e).trim(),
          boxId: String(data.boxId || b).trim() || "1"
        };
      }
    }
  }
  return null;
}

/**
 * Seat 라벨·카드 ID(eventId)·Box ID 변경 (모달 등에서 호출)
 * @returns {Promise<boolean>} 성공 시 true
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

  if (!targetSeatId) return false;

  if (!nextLabel) {
    alert("Seat 라벨은 비울 수 없습니다.");
    return false;
  }
  if (!isValidSeatLabel(nextLabel)) {
    alert("Seat 라벨은 영문/숫자 기준으로 입력해주세요. (예: 1, A1, VIP_1)");
    return false;
  }
  if (!nextEventId || !nextBoxId) {
    alert("카드 ID(eventId)와 Box ID를 모두 입력해주세요.");
    return false;
  }

  if (!isValidLayoutRouteIdPart(nextEventId) || !isValidLayoutRouteIdPart(nextBoxId)) {
    alert(
      "카드 ID / Box ID 형식이 올바르지 않습니다. (비어 있지 않고, / 나 __ 는 사용할 수 없습니다.)\nindex「카드 관리」·layout 주소창의 eventId·boxId를 확인하세요."
    );
    return false;
  }
  const seat = getSeatById(targetSeatId);
  if (!seat) {
    alert("Seat를 찾을 수 없습니다.");
    return false;
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
    return false;
  }

  const foundDoc = await findGlobalSeatDocRef(targetSeatId, eventCards);
  if (!foundDoc?.snap?.exists()) {
    alert("Firestore에서 이 Seat 문서를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.");
    return false;
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
    return false;
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
    return true;
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
        return false;
      }
      const oldSnap = foundDoc?.snap || (await getDoc(oldRef));
      if (!oldSnap.exists()) {
        alert("원본 Seat 문서를 찾을 수 없습니다.");
        return false;
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
      await deleteDoc(oldRef);
    }
  }

  const uid = String(seat.personUid || "").trim();
  if (uid) {
    const eventDisplayTitle = await resolveTournamentEventTitle(resolvedNextEventId);
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
        eventTitle: eventDisplayTitle,
        boxId: nextBoxId,
        seatId: targetSeatId,
        seatLabel: nextLabel,
        targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(resolvedNextEventId)}&boxId=${encodeURIComponent(nextBoxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`,
        message: `${eventDisplayTitle} / Seat ${nextLabel} ${
          moved ? "배치(카드·Box)가 변경되었습니다." : "라벨이 변경되었습니다."
        }`,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  }

  const oldDocId = foundDoc.ref.id;
  if (moved && oldDocId !== newDocId) {
    await syncLayoutProjection(syncPrevParsed.eventId, syncPrevParsed.boxId);
    await syncLayoutProjection(resolvedNextEventId, nextBoxId);
  } else {
    await syncLayoutProjection(resolvedNextEventId, nextBoxId);
  }

  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
  if (idx >= 0) {
    GL.globalSeats[idx] = {
      ...GL.globalSeats[idx],
      label: nextLabel,
      currentEventId: resolvedNextEventId,
      mappedEventId: resolvedNextEventId,
      boxId: nextBoxId,
      sourceLayoutDocId: getProjectionDocId(resolvedNextEventId, nextBoxId)
    };
  }
  if (GL.activeTab === "seat") renderSeatPanel();
  renderSeats(GL.globalSeats);

  if (moved && oldDocId !== newDocId) {
    const layoutUrl = `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(resolvedNextEventId)}&boxId=${encodeURIComponent(nextBoxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`;
    if (
      window.confirm(
        "변경된 카드·Box의 배치 화면(layout.html)으로 이동할까요?\n(취소하면 통합 배치도에 그대로 있으며, 나중에 직접 열어도 됩니다.)"
      )
    ) {
      sessionStorage.setItem("eventId", resolvedNextEventId);
      sessionStorage.setItem("boxId", nextBoxId);
      location.href = layoutUrl;
    }
  }

  return true;
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
  GL.lastGlobalUndo = { kind: "add_seat", seatId, eventId: eid, boxId: bid };

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
