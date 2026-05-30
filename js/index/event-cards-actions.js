import { auth } from "../firebase.js";
import { deleteDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { ensureTournamentContextOrAlert, getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getEventDocRef } from "./event-cards-firestore-refs.js";
import {
  getEventCardIdFromRecord,
  isValidEventCardPart,
  normalizeEventCardDate,
  parseEventInstanceDocId
} from "../shared/tournament-event-instance.js";
import { resolveEventDocIdFromForm, resolveSelectedEventDocId } from "./event-cards-ids.js";
import { ensureLayoutEventShellAfterCardSave } from "./event-cards-layout-shell.js";
import { forceCheckOutUsersForDeletedEvent } from "./event-cards-delete-cleanup.js";

function canManageCurrentTournamentOps() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;
  return canUseTournamentOps(auth.currentUser?.email, IX.currentUserProfile, tournamentId);
}

export async function saveEventCard() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!canManageCurrentTournamentOps()) {
    alert("이 대회에 대한 운영 권한이 없습니다.");
    return;
  }

  const cardId = IX.eventCardId.value.trim();
  const boxId = IX.eventCardBoxId.value.trim();
  const date = normalizeEventCardDate(IX.eventCardDate.value.trim());

  if (!cardId) {
    alert("카드 ID를 입력하세요.");
    return;
  }

  if (!isValidEventCardPart(cardId)) {
    alert("카드 ID에 /, __, ~ 문자는 사용할 수 없습니다.");
    return;
  }

  if (!boxId || !isValidEventCardPart(boxId)) {
    alert("유효한 Box ID를 입력하세요. /, __, ~ 문자는 사용할 수 없습니다.");
    return;
  }

  if (!date) {
    alert("날짜를 입력하세요.");
    return;
  }

  let docId = resolveEventDocIdFromForm();
  if (!docId) {
    alert("카드 정보가 올바르지 않습니다.");
    return;
  }

  const selectedDocId = String(IX.eventCardSelect?.value || "").trim();
  if (
    selectedDocId &&
    selectedDocId !== docId &&
    !parseEventInstanceDocId(selectedDocId)
  ) {
    const prev = IX.events.find((e) => String(e.id || "") === selectedDocId);
    if (
      prev &&
      normalizeEventCardDate(prev.date) === date &&
      getEventCardIdFromRecord(prev) === cardId &&
      String(prev.boxId || "") === boxId
    ) {
      docId = selectedDocId;
    }
  }

  const titleRaw = IX.eventCardTitle.value.trim();
  const title = titleRaw || `Event ${cardId}`;
  if (!titleRaw) IX.eventCardTitle.value = title;

  try {
    await setDoc(
      getEventDocRef(docId),
      {
        cardId,
        boxId,
        date,
        title,
        start: IX.eventCardStart.value.trim(),
        close: IX.eventCardClose.value.trim()
      },
      { merge: true }
    );

    await ensureLayoutEventShellAfterCardSave({
      tournamentId,
      eventId: docId,
      boxId
    });

    alert(
      "카드가 저장되었습니다.\n같은 카드 ID·Box ID라도 날짜가 다르면 별도 카드로 생성됩니다."
    );
  } catch (err) {
    console.error(err);
    alert("카드 저장에 실패했습니다.");
  }
}

export async function deleteEventCardCurrent() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!canManageCurrentTournamentOps()) {
    alert("이 대회에 대한 운영 권한이 없습니다.");
    return;
  }

  const docId = resolveSelectedEventDocId();
  const cardId = IX.eventCardId.value.trim();
  const boxId = IX.eventCardBoxId.value.trim();

  if (!docId) {
    alert("삭제할 카드가 없습니다.");
    return;
  }

  const ok = confirm(
    `"${cardId || docId}" (${IX.eventCardDate?.value || "날짜 없음"}) 카드를 삭제할까요?\n배치 중인 딜러는 강제 퇴근 처리됩니다.`
  );
  if (!ok) return;

  try {
    const { affectedUsers } = await forceCheckOutUsersForDeletedEvent({
      eventId: docId,
      boxId
    });

    await deleteDoc(getEventDocRef(docId));

    alert(
      affectedUsers.length
        ? `카드가 삭제되었습니다.\n배치 중이던 ${affectedUsers.length}명은 강제 퇴근 처리되었습니다.`
        : "카드가 삭제되었습니다."
    );
  } catch (err) {
    console.error(err);
    alert("카드 삭제에 실패했습니다.");
  }
}
