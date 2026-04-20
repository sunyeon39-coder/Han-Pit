/**
 * layout.html: 현재 Seat/대기 상태를 딜러 출석(프로필 patch)에 반영
 */
export function createLayoutDealerAttendanceSync(deps) {
  const {
    waitingState,
    eventState,
    EVENT_ID,
    BOX_ID,
    isEmptyPerson,
    getWaitingIdentity,
    getSeatIdentity,
    applyDealerAttendancePatchesBatched
  } = deps;

  async function syncStatusesFromCurrentState() {
    const waitingByUid = new Map();
    waitingState.waiting.forEach((w) => {
      const uid = String(w.uid || "").trim();
      if (!uid) return;
      waitingByUid.set(uid, w);
    });

    const seatByUid = new Map();
    eventState.seats.forEach((seat) => {
      const uid = String(seat.personUid || "").trim();
      if (!uid || isEmptyPerson(seat.person)) return;
      seatByUid.set(uid, seat);
    });

    const allUids = new Set([...waitingByUid.keys(), ...seatByUid.keys()]);
    const pairs = [];

    for (const uid of allUids) {
      const seat = seatByUid.get(uid);
      if (seat) {
        pairs.push({
          uid,
          patch: {
            email: String(seat.personEmail || "").trim(),
            nickname: String(seat.person || "").trim(),
            status: "assigned",
            currentEventId: EVENT_ID,
            currentBoxId: BOX_ID,
            currentSeatId: String(seat.id || "").trim(),
            currentSeatLabel: String(seat.label ?? seat.no ?? "")
          }
        });
        continue;
      }

      const waiting = waitingByUid.get(uid);
      if (waiting) {
        pairs.push({
          uid,
          patch: {
            email: String(waiting.email || "").trim(),
            nickname: String(waiting.name || "").trim(),
            status: "waiting",
            currentEventId: "",
            currentBoxId: "",
            currentSeatId: "",
            currentSeatLabel: ""
          }
        });
      }
    }

    if (pairs.length) await applyDealerAttendancePatchesBatched(pairs);
  }

  async function syncCurrentEventUserTruth() {
    const seatKeys = new Map();
    const waitingKeys = new Map();

    eventState.seats.forEach((seat) => {
      if (isEmptyPerson(seat.person)) return;

      const key = getSeatIdentity(seat);
      if (!key) return;

      seatKeys.set(key, {
        uid: String(seat.personUid || "").trim(),
        email: String(seat.personEmail || "").trim(),
        nickname: String(seat.person || "").trim(),
        seatId: String(seat.id || "").trim(),
        seatLabel: String(seat.label ?? seat.no ?? "")
      });
    });

    waitingState.waiting.forEach((w) => {
      const key = getWaitingIdentity(w);
      if (!key) return;

      waitingKeys.set(key, {
        uid: String(w.uid || "").trim(),
        email: String(w.email || "").trim(),
        nickname: String(w.name || "").trim()
      });
    });

    const pairs = [];
    for (const [, item] of seatKeys) {
      if (!item.uid) continue;
      pairs.push({
        uid: item.uid,
        patch: {
          email: item.email,
          nickname: item.nickname,
          status: "assigned",
          currentEventId: EVENT_ID,
          currentBoxId: BOX_ID,
          currentSeatId: item.seatId,
          currentSeatLabel: item.seatLabel
        }
      });
    }

    for (const [key, item] of waitingKeys) {
      if (seatKeys.has(key)) continue;
      if (!item.uid) continue;
      pairs.push({
        uid: item.uid,
        patch: {
          email: item.email,
          nickname: item.nickname,
          status: "waiting",
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: ""
        }
      });
    }

    if (pairs.length) await applyDealerAttendancePatchesBatched(pairs);
  }

  return { syncStatusesFromCurrentState, syncCurrentEventUserTruth };
}
