/**
 * layout.html: 좌석/대기열 뮤테이션, 표시용 대기 목록, 전역 좌석과 정체성 기반 필터
 */
import { normalizeWaitingName } from "./layout-main-waiting-normalize.js";
import { layoutGetBestDisplayName, layoutSyncDisplayNameFallback } from "./layout-main-remote.js";
import { createSeatWaitingMutationQueue } from "./layout-seat-waiting-mutation-queue.js";
import { createSeatWaitingIdentityHelpers } from "./layout-seat-waiting-identity-helpers.js";

export function createLayoutSeatWaitingMutations(deps) {
  const {
    eventState,
    waitingState,
    ui,
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    getCurrentTournamentId,
    canManageLayout,
    isEmptyPerson,
    makeUid,
    getIdentityKey,
    getWaitingIdentity,
    getSeatIdentity,
    normalizeWaitingEntry,
    layoutViewport,
    getGlobalSeatsMerge,
    getHealUndo,
    getDealerMoves,
    getLocalReconcile,
    getAttendanceWaiting,
    touchEvent,
    touchWaiting,
    writeUserNotification,
    clearUserSeatNotification,
    getCurrentEventTitle,
    buildSeatTargetUrl,
    render
  } = deps;

  const { runSeatWaitingMutationSerialized, enqueueHealAfterMutation } = createSeatWaitingMutationQueue();

  const {
    isIdentitySeatedAnywhereInTournament,
    getWaitingListForDisplay,
    findSeatByIdentity
  } = createSeatWaitingIdentityHelpers({
    eventState,
    waitingState,
    TOURNAMENT_ID,
    isEmptyPerson,
    getSeatIdentity,
    getWaitingIdentity,
    getGlobalSeatsMerge,
    getAttendanceWaiting,
    makeUid
  });

  function resolveRawWaiting(waitingId) {
    const fromState = findWaiting(waitingId);
    if (fromState) return fromState;
    return getWaitingListForDisplay().find((x) => x.id === waitingId) || null;
  }

  function clearWaitingSelectionIfSeated() {
    const wid = ui.selectedWaitingId;
    if (!wid) return;
    const w = resolveRawWaiting(wid);
    if (!w) return;
    if (isIdentitySeatedAnywhereInTournament(getWaitingIdentity(w))) {
      ui.selectedWaitingId = null;
    }
  }

  function removeWaitingById(waitingId) {
    const idx = waitingState.waiting.findIndex((w) => w.id === waitingId);
    if (idx >= 0) {
      waitingState.waiting.splice(idx, 1);
      return true;
    }
    return false;
  }

  function findWaiting(waitingId) {
    return waitingState.waiting.find((w) => w.id === waitingId) || null;
  }

  function findSeat(seatId) {
    return eventState.seats.find((s) => s.id === seatId) || null;
  }

  function getNextSeatPosition() {
    const { width, height } = layoutViewport.getCanvasSize();
    const PAD = 16;
    const BOX_W = 170;
    const BOX_H = 90;
    const GAP_X = 16;
    const GAP_Y = 16;
    const START_Y = 24;
    const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP_X) / (BOX_W + GAP_X)));

    const index = eventState.seats.length;
    const col = index % cols;
    const row = Math.floor(index / cols);

    let x = PAD + col * (BOX_W + GAP_X);
    let y = START_Y + row * (BOX_H + GAP_Y);

    const maxX = Math.max(PAD, width - BOX_W - PAD);
    const maxY = Math.max(PAD, height - BOX_H - PAD);

    x = Math.max(PAD, Math.min(x, maxX));
    y = Math.max(PAD, Math.min(y, maxY));

    return { x, y };
  }

  function promptSeatLabel(defaultLabel) {
    if (!canManageLayout()) return null;

    const msg = `Seat 라벨을 입력하세요 (숫자/영어/원하는 텍스트)\n예: 1, A, VIP, Table1`;
    const input = prompt(msg, defaultLabel);

    if (input === null) return null;

    const v = String(input).trim();
    return v || defaultLabel;
  }

  function addSeat() {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      getHealUndo().captureLayoutUndo("add_seat");

      const id = makeUid("seat");
      const no = eventState.nextSeatNo++;
      const order = eventState.nextSeatOrder++;
      const labelDefault = String(no);
      const label = promptSeatLabel(labelDefault);

      if (label === null) {
        eventState.nextSeatNo--;
        eventState.nextSeatOrder--;
        return;
      }

      const { x, y } = getNextSeatPosition();

      eventState.seats.push({
        id,
        label,
        no,
        order,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        x,
        y
      });

      touchEvent(true);
      render();
    });
  }

  function deleteSeat(seatId) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      getHealUndo().captureLayoutUndo("delete_seat");

      const idx = eventState.seats.findIndex((s) => s.id === seatId);
      if (idx < 0) return;

      const seat = eventState.seats[idx];
      const prevName = String(seat.person || "").trim();
      const prevUid = String(seat.personUid || "").trim();
      const prevEmail = String(seat.personEmail || "").trim();

      eventState.seats.splice(idx, 1);

      if (ui.selectedSeatId === seatId) ui.selectedSeatId = null;

      if (prevUid) {
        await clearUserSeatNotification(prevUid, "seat_deleted");
      }

      touchEvent(true);
      render();

      if (prevUid && prevName) {
        const dm = getDealerMoves();
        if (dm) {
          await dm.moveDealerToWaiting({
            uid: prevUid,
            email: prevEmail,
            nickname: prevName
          });
        }
      }
    });
  }

  function addWaiting(name, meta = {}) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      const v = normalizeWaitingName(name);
      if (!v) return;

      const uid = String(meta.uid || "").trim();
      const email = String(meta.email || "").trim();
      const tournamentId = String(meta.tournamentId || TOURNAMENT_ID || "").trim();
      const identityKey = getIdentityKey({ uid, email, name: v });
      const exists = waitingState.waiting.some((w) => getWaitingIdentity(w) === identityKey);
      if (exists) return;

      getHealUndo().captureLayoutUndo("add_waiting");

      waitingState.waiting.push({
        id: makeUid("wait"),
        name: v,
        uid,
        email,
        tournamentId,
        addedAt: Date.now(),
        carryStartedAt: meta.carryStartedAt ? Number(meta.carryStartedAt) : null
      });

      touchWaiting(true);
      render();
    });
  }

  function deleteWaiting(waitingId) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      getHealUndo().captureLayoutUndo("delete_waiting");

      removeWaitingById(waitingId);
      if (ui.selectedWaitingId === waitingId) ui.selectedWaitingId = null;
      touchWaiting(true);
      render();
    });
  }

  function setWaitingBlockChecked(waitingId, checked) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;
      const waiting = findWaiting(waitingId);
      if (!waiting) return;

      const now = Date.now();
      const nextChecked = checked === true;
      const prevChecked = waiting.blockChecked === true;
      if (prevChecked === nextChecked) return;

      if (nextChecked) {
        waiting.blockChecked = true;
        waiting.blockCheckedAt = now;
      } else {
        const startedAt = Number(waiting.blockCheckedAt || 0);
        const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
        waiting.blockChecked = false;
        waiting.blockCheckedAt = null;
        waiting.blockAccumulatedMs = Number(waiting.blockAccumulatedMs || 0) + elapsed;
      }

      touchWaiting(true);
      render();
    });
  }

  function removeWaitingEntriesByIdentity(identityKey) {
    if (!identityKey) return 0;

    const before = waitingState.waiting.length;
    waitingState.waiting = waitingState.waiting.filter((w) => getWaitingIdentity(w) !== identityKey);
    return before - waitingState.waiting.length;
  }

  function assignWaitingToSeat(waitingId, seatId) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      const waiting = normalizeWaitingEntry(resolveRawWaiting(waitingId));
      const seat = findSeat(seatId);
      if (!waiting || !seat) return;
      if (waiting.blockChecked === true) return;

      getHealUndo().captureLayoutUndo("assign_waiting_to_seat");

      const incomingName = String(waiting.name || "").trim();
      const incomingUid = String(waiting.uid || "").trim();
      const incomingEmail = String(waiting.email || "").trim();

      const skipProfileDisplayFetch =
        incomingName.length >= 2 && !incomingName.includes("@");
      const displayNameFromProfilePromise = skipProfileDisplayFetch
        ? null
        : layoutGetBestDisplayName(incomingUid, incomingEmail, incomingName);

      let incomingDisplayName = skipProfileDisplayFetch
        ? incomingName
        : layoutSyncDisplayNameFallback(incomingEmail, incomingName);

      const incomingKey = getIdentityKey({
        uid: incomingUid,
        email: incomingEmail,
        name: incomingDisplayName
      });

      const prevName = String(seat.person || "").trim();
      const prevUid = String(seat.personUid || "").trim();
      const prevEmail = String(seat.personEmail || "").trim();
      const prevSeatedAt = seat.seatedAt ? Number(seat.seatedAt) : null;
      const prevOccupied = !!prevName && prevName !== "비어있음";

      if (incomingKey) {
        removeWaitingEntriesByIdentity(incomingKey);
      } else {
        removeWaitingById(waitingId);
      }

      const duplicatedSeat = findSeatByIdentity(incomingKey, seat.id);
      if (duplicatedSeat) {
        getLocalReconcile().clearSeatLocally(duplicatedSeat);
      }

      const dealerMoves = getDealerMoves();

      seat.person = incomingDisplayName || "비어있음";
      seat.personUid = incomingUid;
      seat.personEmail = incomingEmail;
      seat.seatedAt = Date.now();

      ui.selectedWaitingId = null;
      ui.selectedSeatId = seat.id;

      touchWaiting(true);
      touchEvent(true);
      render();

      const needsPrevAwait = prevOccupied && prevUid && prevUid !== incomingUid;
      const prevAwaitPromise = needsPrevAwait
        ? Promise.all([
            clearUserSeatNotification(prevUid, "seat_reassigned"),
            ...(dealerMoves
              ? [
                  dealerMoves.moveDealerToWaiting({
                    uid: prevUid,
                    email: prevEmail,
                    nickname: prevName,
                    carryStartedAt: prevSeatedAt || Date.now()
                  })
                ]
              : [])
          ])
        : Promise.resolve();

      const nameAwaitPromise = displayNameFromProfilePromise || Promise.resolve(null);

      if (needsPrevAwait || displayNameFromProfilePromise) {
        try {
          const [, resolvedRaw] = await Promise.all([prevAwaitPromise, nameAwaitPromise]);
          if (displayNameFromProfilePromise) {
            const trimmed = String(resolvedRaw || "").trim();
            if (trimmed) {
              const still = findSeat(seat.id);
              if (still && String(still.personUid || "").trim() === incomingUid) {
                if (trimmed !== String(still.person || "").trim()) {
                  still.person = trimmed;
                  touchEvent(true);
                  render();
                }
              }
              incomingDisplayName = trimmed;
            }
          }
        } catch (err) {
          console.error("assignWaitingToSeat afterpaint await error", err);
        }
      }

      const followUps = [];

      if ((incomingUid || incomingDisplayName) && dealerMoves) {
        followUps.push(
          dealerMoves.moveDealerToAssigned({
            uid: incomingUid,
            email: incomingEmail,
            name: incomingDisplayName,
            resolvedDisplayName: incomingDisplayName,
            seatId: seat.id,
            seatLabel: seat.label ?? seat.no ?? "",
            eventId: EVENT_ID,
            boxId: BOX_ID
          })
        );
      }

      if (incomingUid) {
        const seatLabel = String(seat.label ?? seat.no ?? "").trim();
        const eventTitle = getCurrentEventTitle();
        const tournamentId = getCurrentTournamentId();

        followUps.push(
          writeUserNotification({
            uid: incomingUid,
            type: "seat_assigned",
            acknowledged: false,
            createdAt: Date.now(),
            tournamentId,
            eventId: EVENT_ID,
            eventTitle,
            boxId: BOX_ID,
            seatId: seat.id,
            seatLabel,
            targetUrl: buildSeatTargetUrl(EVENT_ID, BOX_ID, seat.id),
            message: `${eventTitle} / Seat ${seatLabel}에 배치되었습니다.`
          })
        );
      }

      if (followUps.length) await Promise.all(followUps);
      enqueueHealAfterMutation(() => getHealUndo().healAndPersistState("assignWaitingToSeat"));
    });
  }

  function clearSeat(seatId) {
    return runSeatWaitingMutationSerialized(async () => {
      if (!canManageLayout()) return;

      const seat = findSeat(seatId);
      if (!seat) return;

      getHealUndo().captureLayoutUndo("clear_seat");

      const prevName = String(seat.person || "").trim();
      const prevUid = String(seat.personUid || "").trim();
      const prevEmail = String(seat.personEmail || "").trim();
      const prevSeatedAt = seat.seatedAt ? Number(seat.seatedAt) : null;
      const hadPerson = !isEmptyPerson(prevName);

      getLocalReconcile().clearSeatLocally(seat);

      touchEvent(true);
      render();

      const dealerMoves = getDealerMoves();

      if (hadPerson) {
        const rel = [];
        if (dealerMoves) {
          rel.push(
            dealerMoves.moveDealerToWaiting({
              uid: prevUid,
              email: prevEmail,
              nickname: prevName,
              carryStartedAt: prevSeatedAt || Date.now()
            })
          );
        }
        if (prevUid) rel.push(clearUserSeatNotification(prevUid, "seat_cleared"));
        if (rel.length) await Promise.all(rel);
      }

      render();
      enqueueHealAfterMutation(() => getHealUndo().healAndPersistState("clearSeat"));
    });
  }

  return {
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    assignWaitingToSeat,
    setWaitingBlockChecked,
    clearSeat,
    findSeat,
    findWaiting,
    findSeatByIdentity,
    getWaitingListForDisplay,
    clearWaitingSelectionIfSeated,
    removeWaitingEntriesByIdentity,
    removeWaitingById
  };
}
