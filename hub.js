/* ===============================
   PROFILE
=============================== */
async function saveNickname() {
  if (!currentUser) return;

  const nickname = profileNickname.value.trim();

  if (nickname.length < 2 || nickname.length > 7) {
    alert("닉네임은 2~7자로 입력해주세요.");
    return;
  }

  try {
    await updateDoc(doc(db, "users", currentUser.uid), { nickname });

    if (currentUserProfile) {
      currentUserProfile.nickname = nickname;
    }

    const cacheUser = usersCache.find((u) => u.uid === currentUser.uid);
    if (cacheUser) {
      cacheUser.nickname = nickname;
    }

    alert("닉네임이 저장되었습니다.");
    closeModal(profileModal);
    renderAdminUserList();
    renderTournaments(tournamentsCache, currentUserProfile);
  } catch (err) {
    console.error(err);
    alert("닉네임 저장에 실패했습니다.");
  }
}

/* ===============================
   TOURNAMENT CRUD
=============================== */
async function saveTournament() {
  if (currentUserProfile?.role !== "admin") return;

  const id = adminTournamentId.value.trim();
  const name = adminTournamentName.value.trim();
  const startDate = adminTournamentStartDate.value.trim();
  const endDate = adminTournamentEndDate.value.trim();
  const logoText = adminTournamentLogoText.value.trim();
  const requiredCode = adminEventCode.value.trim();

  if (!id || !name) {
    alert("대회 ID와 대회명을 입력해주세요.");
    return;
  }

  try {
    await setDoc(
      doc(db, "tournaments", id),
      { name, startDate, endDate, logoText, requiredCode },
      { merge: true }
    );

    alert("대회가 저장되었습니다.");
  } catch (err) {
    console.error(err);
    alert("대회 저장에 실패했습니다.");
  }
}

async function deleteTournamentCurrent() {
  if (currentUserProfile?.role !== "admin") return;

  const id = adminTournamentId.value.trim();
  if (!id) {
    alert("삭제할 대회가 없습니다.");
    return;
  }

  const ok = confirm(`"${id}" 대회를 삭제할까요?`);
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "tournaments", id));
    alert("대회가 삭제되었습니다.");
  } catch (err) {
    console.error(err);
    alert("대회 삭제에 실패했습니다.");
  }
}

/* ===============================
   ACCESS / CODE ACTIONS
=============================== */
async function grantEventDirectly(uid, eventId) {
  try {
    await setDoc(
      doc(db, "users", uid),
      {
        allowedEvents: {
          [eventId]: true
        }
      },
      { merge: true }
    );

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.allowedEvents = {
        ...(user.allowedEvents || {}),
        [eventId]: true
      };
    }

    renderAdminUserList();
    alert("직접 허용이 저장되었습니다.");
  } catch (err) {
    console.error(err);
    alert("직접 허용 저장에 실패했습니다.");
  }
}

async function revokeEventDirectly(uid, eventId) {
  try {
    await updateDoc(doc(db, "users", uid), {
      [`allowedEvents.${eventId}`]: deleteField()
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user?.allowedEvents) {
      delete user.allowedEvents[eventId];
    }

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };

    const stillAllowed =
  user?.role === "admin" ||
  user?.allowedEvents?.[eventId] === true ||
  (
    String(user?.accessCode || "").trim() &&
    String(
      tournamentsCache.find((t) => t.id === eventId)?.requiredCode || ""
    ).trim() &&
    String(user?.accessCode || "").trim() ===
      String(tournamentsCache.find((t) => t.id === eventId)?.requiredCode || "").trim()
  );

if (user && !stillAllowed) {
  cleaned = await cleanupUserFromLayoutState(user, eventId);
}

    renderAdminUserList();

    if (cleaned.waitingRemoved > 0 || cleaned.seatRemoved > 0) {
      alert(
        `직접 허용이 해제되었고, 대기 ${cleaned.waitingRemoved}건 / 좌석 ${cleaned.seatRemoved}건 정리되었습니다.`
      );
    } else {
      alert("직접 허용이 해제되었습니다.");
    }
  } catch (err) {
    console.error(err);
    alert("허용 해제에 실패했습니다.");
  }
}

async function assignEventCodeToUser(uid, eventId) {
  try {
    const tournament = tournamentsCache.find((t) => t.id === eventId);
    const requiredCode = String(tournament?.requiredCode || "").trim();

    if (!requiredCode) {
      alert("선택한 대회에 설정된 코드가 없습니다.");
      return;
    }

    await updateDoc(doc(db, "users", uid), {
      accessCode: requiredCode
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = requiredCode;
    }

    renderAdminUserList();
    alert(`유저 코드가 부여되었습니다: ${requiredCode}`);
  } catch (err) {
    console.error(err);
    alert("유저 코드 부여에 실패했습니다.");
  }
}

async function removeUserCode(uid) {
  try {
    await updateDoc(doc(db, "users", uid), {
      accessCode: ""
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = "";
    }

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };

    const selectedEventId = adminEventSelect?.value || "";

if (user && !userStillHasAccessToSelectedEvent(user)) {
  cleaned = await cleanupUserFromLayoutState(user, selectedEventId);
}

    renderAdminUserList();

    if (cleaned.waitingRemoved > 0 || cleaned.seatRemoved > 0) {
      alert(
        `유저 코드가 제거되었고, 대기 ${cleaned.waitingRemoved}건 / 좌석 ${cleaned.seatRemoved}건 정리되었습니다.`
      );
    } else {
      alert("유저 코드가 제거되었습니다.");
    }
  } catch (err) {
    console.error(err);
    alert("유저 코드 제거에 실패했습니다.");
  }
}

function showUserCode(uid) {
  const user = usersCache.find((u) => u.uid === uid);
  if (!user) return;

  alert(`${user.nickname || "이름 없음"}\n접근 코드: ${user.accessCode || "없음"}`);
}