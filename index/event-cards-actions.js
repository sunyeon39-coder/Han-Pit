import { auth } from "../firebase.js";
import { deleteDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import { ensureTournamentContextOrAlert, isValidDocId } from "./core-utils.js";
import { normalizeDateString } from "./time-utils.js";
import { IX } from "./state.js";
import { getEventDocRef } from "./event-cards-firestore-refs.js";
import { ensureLayoutEventShellAfterCardSave } from "./event-cards-layout-shell.js";
import { forceCheckOutUsersForDeletedEvent } from "./event-cards-delete-cleanup.js";

export async function saveEventCard() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!getIsAdmin(auth.currentUser, IX.currentUserProfile)) return;

  const id = IX.eventCardId.value.trim();

  if (!id) {
    alert("카드 ID를 입력하세요.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("카드 ID에는 '/' 문자를 사용할 수 없습니다.");
    return;
  }

  const boxId = IX.eventCardBoxId.value.trim();
  if (!boxId || !isValidDocId(boxId)) {
    alert("유효한 Box ID를 입력하세요. '/' 문자는 사용할 수 없습니다.");
    return;
  }

  const titleRaw = IX.eventCardTitle.value.trim();
  const title = titleRaw || `Event ${id}`;
  if (!titleRaw) IX.eventCardTitle.value = title;

  try {
    await setDoc(
      getEventDocRef(id),
      {
        boxId,
        date: normalizeDateString(IX.eventCardDate.value.trim()),
        title,
        start: IX.eventCardStart.value.trim(),
        close: IX.eventCardClose.value.trim()
      },
      { merge: true }
    );

    await ensureLayoutEventShellAfterCardSave({
      tournamentId,
      eventId: id,
      boxId
    });

    alert("카드가 저장되었습니다. 통합 배치도에서 같은 카드 ID·Box ID로 Seat을 추가할 수 있습니다.");
  } catch (err) {
    console.error(err);
    alert("카드 저장에 실패했습니다.");
  }
}

export async function deleteEventCardCurrent() {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;
  if (!getIsAdmin(auth.currentUser, IX.currentUserProfile)) return;

  const id = IX.eventCardId.value.trim();

  if (!id) {
    alert("삭제할 카드가 없습니다.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("유효하지 않은 카드 ID입니다.");
    return;
  }

  const boxId = IX.eventCardBoxId.value.trim();

  const ok = confirm(`"${id}" 카드를 삭제할까요?\n배치 중인 딜러는 강제 퇴근 처리됩니다.`);
  if (!ok) return;

  try {
    const { affectedUsers } = await forceCheckOutUsersForDeletedEvent({
      eventId: id,
      boxId
    });

    await deleteDoc(getEventDocRef(id));

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
