/**
 * layout.html: layout_events / global_waiting / dealer_attendance Firestore onSnapshot 구독
 */
import { onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";

export function createLayoutRealtimeBind(deps) {
  const {
    EVENT_REF,
    WAITING_REF,
    TOURNAMENT_ID,
    attendanceWaitingState,
    eventState,
    waitingState,
    EVENT_ID,
    BOX_ID,
    normalizeWaitingEntry,
    applyGlobalSeatMapToEventSeats,
    isLayoutOptimisticMutationInFlight,
    onAfterEventRemoteSnapshot,
    onAfterWaitingRemoteSnapshot,
    onAfterAttendanceRemoteSnapshot
  } = deps;

  function bindRealtime() {
    onSnapshot(
      EVENT_REF,
      (snap) => {
        if (!snap.exists()) return;
        if (typeof isLayoutOptimisticMutationInFlight === "function" && isLayoutOptimisticMutationInFlight()) {
          return;
        }

        const next = snap.data() || {};
        const nextUpdatedAt = Number(next.updatedAt || 0);

        eventState.version = next.version || 2;
        eventState.eventId = next.eventId || EVENT_ID;
        eventState.boxId = next.boxId || BOX_ID;
        eventState.nextSeatNo = next.nextSeatNo || 1;
        eventState.nextSeatOrder = next.nextSeatOrder || 1;
        eventState.seats = Array.isArray(next.seats) ? next.seats : [];
        eventState.updatedAt = nextUpdatedAt || Date.now();

        applyGlobalSeatMapToEventSeats();
        onAfterEventRemoteSnapshot();
      },
      (err) => {
        console.error("EVENT_REF snapshot error:", err);
      }
    );

    onSnapshot(
      WAITING_REF,
      (snap) => {
        if (!snap.exists()) return;
        if (typeof isLayoutOptimisticMutationInFlight === "function" && isLayoutOptimisticMutationInFlight()) {
          return;
        }

        const nextW = snap.data() || {};
        const nextUpdatedAt = Number(nextW.updatedAt || 0);

        waitingState.version = nextW.version || 2;
        waitingState.waiting = Array.isArray(nextW.waiting)
          ? nextW.waiting.map((raw) => normalizeWaitingEntry(raw)).filter(Boolean)
          : [];
        waitingState.updatedAt = nextUpdatedAt || Date.now();

        onAfterWaitingRemoteSnapshot();
      },
      (err) => {
        console.error("WAITING_REF snapshot error:", err);
      }
    );

    const tid = String(TOURNAMENT_ID || "").trim();
    if (tid && attendanceWaitingState) {
      onSnapshot(
        dealerAttendanceQueryForTournament(tid),
        (snap) => {
          attendanceWaitingState.items = filterAttendanceDocsForTournament(snap.docs, tid)
            .map((d) => {
              const data = d.data() || {};
              return { id: d.id, ...data };
            })
            .filter((d) => {
              const status = String(d.status || "").trim();
              return status === "waiting" || status === "checked_in";
            });
          if (typeof onAfterAttendanceRemoteSnapshot === "function") {
            onAfterAttendanceRemoteSnapshot();
          }
        },
        (err) => {
          console.error("dealer_attendance snapshot error:", err);
        }
      );
    }
  }

  return { bindRealtime };
}
