/**
 * layout.html: 대기 목록·Seat 로컬 상태 정합(중복 키 제거 등)
 */
export function createLayoutLocalStateReconcile(deps) {
  const {
    waitingState,
    eventState,
    isEmptyPerson,
    normalizeWaitingEntry,
    getWaitingIdentity,
    getSeatIdentity
  } = deps;

  function clearSeatLocally(seat) {
    if (!seat) return;

    seat.person = "비어있음";
    seat.personUid = "";
    seat.personEmail = "";
    seat.seatedAt = null;
  }

  function reconcileLocalState() {
    let changedEvent = false;
    let changedWaiting = false;

    const nextWaiting = [];
    const waitingSeen = new Map();

    for (const raw of waitingState.waiting) {
      const w = normalizeWaitingEntry(raw);
      if (!w) {
        changedWaiting = true;
        continue;
      }

      const key = getWaitingIdentity(w);
      if (!key) {
        changedWaiting = true;
        continue;
      }

      const existing = waitingSeen.get(key);
      if (!existing) {
        waitingSeen.set(key, w);
        nextWaiting.push(w);
        continue;
      }

      changedWaiting = true;

      const existingAddedAt = Number(existing.addedAt || Date.now());
      const nextAddedAt = Number(w.addedAt || Date.now());

      if (nextAddedAt < existingAddedAt) {
        existing.addedAt = nextAddedAt;
      }

      if (!existing.carryStartedAt && w.carryStartedAt) {
        existing.carryStartedAt = Number(w.carryStartedAt);
      }
    }

    waitingState.waiting = nextWaiting;

    const seatSeen = new Map();

    for (const seat of eventState.seats) {
      if (isEmptyPerson(seat.person)) continue;

      const key = getSeatIdentity(seat);
      if (!key) continue;

      const already = seatSeen.get(key);
      if (!already) {
        seatSeen.set(key, seat);
        continue;
      }

      const alreadyTime = Number(already.seatedAt || Date.now());
      const seatTime = Number(seat.seatedAt || Date.now());

      if (seatTime < alreadyTime) {
        clearSeatLocally(already);
        seatSeen.set(key, seat);
      } else {
        clearSeatLocally(seat);
      }

      changedEvent = true;
    }

    return { changedEvent, changedWaiting };
  }

  return { clearSeatLocally, reconcileLocalState };
}
