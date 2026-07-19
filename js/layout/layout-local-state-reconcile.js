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

      // 같은 사람의 중복 대기 행을 하나로 합칠 때 BLOCK 상태를 놓치면 안 된다.
      // 예전에는 addedAt/carryStartedAt만 옮기고 blockChecked는 그대로 버려서,
      // 중복이 하필 "블록 안 된" 쪽이 먼저 남아있으면 이 정리(heal)가 실행되는
      // 순간(다른 조작으로 realtime 갱신이 한 번이라도 오면) BLOCK이 저장까지
      // 조용히 풀려 버렸다 — "시간이 지나면 블록이 풀린다"는 증상의 원인.
      // 둘 중 하나라도 블록 중이면 합친 결과도 블록 상태를 유지한다.
      if (!existing.blockChecked && w.blockChecked) {
        existing.blockChecked = true;
        existing.blockCheckedAt = w.blockCheckedAt ?? null;
        existing.blockAccumulatedMs = Number(w.blockAccumulatedMs || 0) || 0;
      } else {
        existing.blockAccumulatedMs = Math.max(
          Number(existing.blockAccumulatedMs || 0) || 0,
          Number(w.blockAccumulatedMs || 0) || 0
        );
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
