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
  validateLayoutEventForGlobalOps
} from "./fs-layout-projection.js";
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
  if (looksLikeDisplayTitleNotId(nextEventId)) {
    alert(
      "EVENT 칸에는 카드 제목이 아니라 카드 ID(예: 숫자·event_1)를 넣어야 합니다.\nindex「카드 관리」에서 해당 카드를 선택하면 카드 ID가 보입니다."
    );
    return false;
  }

  const seat = getSeatById(targetSeatId);
  if (!seat) {
    alert("Seat를 찾을 수 없습니다.");
    return false;
  }

  const prevEventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const prevBoxId = String(seat.boxId || "").trim();
  if (!prevEventId || !prevBoxId) {
    alert("현재 Seat의 카드/Box 정보가 없습니다.");
    return false;
  }

  const prevLabel = String(seat.label ?? seat.no ?? "").trim();
  const moved = nextEventId !== prevEventId || nextBoxId !== prevBoxId;
  const labelOnly = !moved && nextLabel === prevLabel;
  if (labelOnly) return false;

  const layoutGate = await validateLayoutEventForGlobalOps(nextEventId, nextBoxId, {
    requireSeatId: targetSeatId
  });
  if (!layoutGate.ok) {
    alert(layoutGate.message);
    return false;
  }

  const oldDocId = buildGlobalSeatDocId(prevEventId, prevBoxId, targetSeatId);
  const newDocId = buildGlobalSeatDocId(nextEventId, nextBoxId, targetSeatId);
  const oldRef = doc(db, "tournaments", GL.tournamentId, "global_seats", oldDocId);
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
  } else {
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
      const oldSnap = await getDoc(oldRef);
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
          mappedEventId: nextEventId,
          currentEventId: nextEventId,
          boxId: nextBoxId,
          sourceLayoutDocId: getProjectionDocId(nextEventId, nextBoxId),
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
    const eventDisplayTitle = await resolveTournamentEventTitle(nextEventId);
    await setDoc(
      getAttendanceRef(db, GL.tournamentId, uid),
      {
        uid,
        tournamentId: GL.tournamentId,
        currentSeatLabel: nextLabel,
        currentEventId: nextEventId,
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
        eventId: nextEventId,
        eventTitle: eventDisplayTitle,
        boxId: nextBoxId,
        seatId: targetSeatId,
        seatLabel: nextLabel,
        targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(nextEventId)}&boxId=${encodeURIComponent(nextBoxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`,
        message: `${eventDisplayTitle} / Seat ${nextLabel} ${
          moved ? "배치(카드·Box)가 변경되었습니다." : "라벨이 변경되었습니다."
        }`,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  }

  if (moved && oldDocId !== newDocId) {
    await syncLayoutProjection(prevEventId, prevBoxId);
    await syncLayoutProjection(nextEventId, nextBoxId);
  } else {
    await syncLayoutProjection(nextEventId, nextBoxId);
  }

  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
  if (idx >= 0) {
    GL.globalSeats[idx] = {
      ...GL.globalSeats[idx],
      label: nextLabel,
      currentEventId: nextEventId,
      mappedEventId: nextEventId,
      boxId: nextBoxId,
      sourceLayoutDocId: getProjectionDocId(nextEventId, nextBoxId)
    };
  }
  if (GL.activeTab === "seat") renderSeatPanel();
  renderSeats(GL.globalSeats);

  if (moved && oldDocId !== newDocId) {
    const layoutUrl = `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(nextEventId)}&boxId=${encodeURIComponent(nextBoxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`;
    if (
      window.confirm(
        "변경된 카드·Box의 배치 화면(layout.html)으로 이동할까요?\n(취소하면 통합 배치도에 그대로 있으며, 나중에 직접 열어도 됩니다.)"
      )
    ) {
      sessionStorage.setItem("eventId", nextEventId);
      sessionStorage.setItem("boxId", nextBoxId);
      location.href = layoutUrl;
    }
  }

  return true;
}

export async function addGlobalSeat() {
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
  const order = GL.globalSeats.length + 1;
  const docId = buildGlobalSeatDocId(eventId, boxId, seatId);

  await setDoc(
    doc(db, "tournaments", GL.tournamentId, "global_seats", docId),
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
      tournamentId: GL.tournamentId,
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
  GL.lastGlobalUndo = { kind: "add_seat", seatId, eventId, boxId };
  seatLabelInput.value = "";
  if (seatEventInput) seatEventInput.value = eventId;
  if (seatBoxInput) seatBoxInput.value = boxId;
  writePersistedSeatAddForm(eventId, boxId);
  syncSeatAddEventPickerFromHidden();
}
