/**
 * layout.html: tournaments/.../global_seats 스냅샷을 로컬 맵에 반영하고 layout_events Seat과 병합
 */
import { onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export function createLayoutGlobalSeatsMerge(deps) {
  const {
    GLOBAL_SEATS_REF,
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    hasValidLayoutRouteContext,
    isEmptyPerson,
    getIdentityKey,
    eventState,
    clearSeatLocally,
    clearWaitingSelectionIfSeated,
    isLayoutOptimisticMutationInFlight,
    onAfterGlobalSeatsSnapshot
  } = deps;

  /** Firestore 전파 전 stale global_seats 가 방금 배치한 로컬 좌석을 비우지 않도록 */
  const RECENT_LOCAL_SEAT_MS = 12000;

  let globalSeatBySeatId = new Map();
  /** 현재 layout 이벤트/박스가 아닌 전역 좌석에 앉아 있는 정체성만 (대기 목록 필터용). */
  let globalSeatedIdentityKeysOutsideCurrentLayout = new Set();
  /**
   * 현재 이벤트/박스 global_seats 에서 person·personUid 가 모두 있는 경우만 (대기 목록 필터).
   * 로컬 좌석 병합보다 전역 스냅샷이 먼저 올 때 잠깐 대기에도 남는 중복을 줄이되, uid 없는 유령 문서는 제외.
   */
  let globalSeatedIdentityKeysOnCurrentLayoutStrict = new Set();
  let stopGlobalSeatsSourceWatch = null;

  function getGlobalSeatedIdentityKeysOutsideCurrentLayout() {
    return globalSeatedIdentityKeysOutsideCurrentLayout;
  }

  function getGlobalSeatedIdentityKeysOnCurrentLayoutStrict() {
    return globalSeatedIdentityKeysOnCurrentLayoutStrict;
  }

  function rebuildGlobalSeatMapFromSnapshot(snap) {
    const next = new Map();
    const outsideLayoutKeys = new Set();
    const currentLayoutStrictKeys = new Set();

    if (!snap || !TOURNAMENT_ID) {
      globalSeatBySeatId = next;
      globalSeatedIdentityKeysOutsideCurrentLayout = outsideLayoutKeys;
      globalSeatedIdentityKeysOnCurrentLayoutStrict = currentLayoutStrictKeys;
      return;
    }

    const hasCurrentLayout = !!(EVENT_ID && BOX_ID);

    snap.docs.forEach((d) => {
      const data = d.data() || {};
      const person = String(data.person || "").trim();
      const pUid = String(data.personUid || "").trim();
      const eid = String(data.currentEventId || data.mappedEventId || "").trim();
      const bid = String(data.boxId || "").trim();
      const isThisLayout = hasCurrentLayout && eid === EVENT_ID && bid === BOX_ID;

      if (!isEmptyPerson(person) && person !== "비어있음") {
        const key = getIdentityKey({
          uid: pUid,
          email: String(data.personEmail || "").trim(),
          name: person
        });
        if (key && !isThisLayout) {
          outsideLayoutKeys.add(key);
        }
        if (key && isThisLayout && pUid) {
          currentLayoutStrictKeys.add(key);
        }
      }

      if (!EVENT_ID || !BOX_ID) return;
      if (eid !== EVENT_ID || bid !== BOX_ID) return;

      const seatId = String(data.seatId || "").trim();
      if (!seatId) return;

      const alertKind = ["emergency", "break"].includes(String(data.alertKind || "").trim())
        ? String(data.alertKind).trim()
        : data.alertActive === true
          ? "emergency"
          : "";
      next.set(seatId, {
        person,
        personUid: String(data.personUid || "").trim(),
        personEmail: String(data.personEmail || "").trim(),
        seatedAt: data.seatedAt != null ? Number(data.seatedAt) : null,
        alertKind,
        alertActive: alertKind !== "",
        alertAt: Number(data.alertAt || 0) || 0
      });
    });

    globalSeatBySeatId = next;
    globalSeatedIdentityKeysOutsideCurrentLayout = outsideLayoutKeys;
    globalSeatedIdentityKeysOnCurrentLayoutStrict = currentLayoutStrictKeys;
  }

  function applyGlobalSeatMapToEventSeats() {
    if (!TOURNAMENT_ID || !EVENT_ID || !BOX_ID) return false;
    if (!(globalSeatBySeatId instanceof Map)) return false;

    let changed = false;

    for (const seat of eventState.seats) {
      const sid = String(seat.id || "").trim();
      if (!sid || !globalSeatBySeatId.has(sid)) continue;

      const g = globalSeatBySeatId.get(sid);
      const gPerson = String(g?.person || "").trim();
      const gEmpty = isEmptyPerson(gPerson) || gPerson === "비어있음";

      // 좌석 상태 표시(alertKind: emergency/break)는 착석 여부와 무관하게 그대로 반영
      const gKind = String(g?.alertKind || "").trim();
      if (String(seat.alertKind || "").trim() !== gKind) {
        seat.alertKind = gKind;
        seat.alertActive = gKind !== "";
        seat.alertAt = Number(g?.alertAt || 0) || 0;
        changed = true;
      }

      if (!gEmpty) {
        const gUid = String(g?.personUid || "").trim();
        const lUid = String(seat.personUid || "").trim();
        const lName = String(seat.person || "").trim();
        if (isEmptyPerson(lName) || lUid !== gUid || lName !== gPerson) {
          seat.person = gPerson;
          seat.personUid = gUid;
          seat.personEmail = String(g?.personEmail || "").trim();
          seat.seatedAt = g?.seatedAt != null ? Number(g.seatedAt) : Date.now();
          changed = true;
        }
      } else if (!isEmptyPerson(seat.person)) {
        const localSeatedAt = Number(seat.seatedAt || 0);
        if (localSeatedAt > 0 && Date.now() - localSeatedAt < RECENT_LOCAL_SEAT_MS) {
          continue;
        }
        clearSeatLocally(seat);
        changed = true;
      }
    }

    if (changed) {
      clearWaitingSelectionIfSeated();
      eventState.updatedAt = Date.now();
    }

    return changed;
  }

  function bindTournamentGlobalSeatsMerge() {
    if (stopGlobalSeatsSourceWatch) {
      stopGlobalSeatsSourceWatch();
      stopGlobalSeatsSourceWatch = null;
    }

    globalSeatBySeatId = new Map();
    globalSeatedIdentityKeysOutsideCurrentLayout = new Set();
    globalSeatedIdentityKeysOnCurrentLayoutStrict = new Set();

    if (!TOURNAMENT_ID || !GLOBAL_SEATS_REF || !hasValidLayoutRouteContext()) {
      return;
    }

    stopGlobalSeatsSourceWatch = onSnapshot(
      GLOBAL_SEATS_REF,
      (snap) => {
        if (
          typeof isLayoutOptimisticMutationInFlight === "function" &&
          isLayoutOptimisticMutationInFlight()
        ) {
          return;
        }
        rebuildGlobalSeatMapFromSnapshot(snap);
        const merged = applyGlobalSeatMapToEventSeats();
        onAfterGlobalSeatsSnapshot(merged);
      },
      (err) => {
        console.error("bindTournamentGlobalSeatsMerge error:", err);
      }
    );
  }

  return {
    getGlobalSeatedIdentityKeysOutsideCurrentLayout,
    getGlobalSeatedIdentityKeysOnCurrentLayoutStrict,
    applyGlobalSeatMapToEventSeats,
    bindTournamentGlobalSeatsMerge
  };
}
