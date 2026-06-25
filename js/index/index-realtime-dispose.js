import { disposeMyUserProfileRealtime } from "../shared/bind-my-user-profile-realtime.js";
import { disposeSeatMapRealtime } from "./seat-map.js";
import { IX } from "./state.js";

/** index — Firestore 실시간 구독 전부 해제 (already-exists / SDK assertion 방지) */
export function disposeIndexRealtimeWatches() {
  if (IX.stopTournamentWatch) {
    IX.stopTournamentWatch();
    IX.stopTournamentWatch = null;
  }
  if (IX.stopEventsWatch) {
    IX.stopEventsWatch();
    IX.stopEventsWatch = null;
  }
  if (IX.stopLayoutEventsWatch) {
    IX.stopLayoutEventsWatch();
    IX.stopLayoutEventsWatch = null;
  }
  if (IX.stopGlobalWaitingWatch) {
    IX.stopGlobalWaitingWatch();
    IX.stopGlobalWaitingWatch = null;
  }
  if (IX.stopDealerAttendanceWatch) {
    IX.stopDealerAttendanceWatch();
    IX.stopDealerAttendanceWatch = null;
  }
  if (IX.stopDealerSeatWatch) {
    IX.stopDealerSeatWatch();
    IX.stopDealerSeatWatch = null;
  }
  if (IX.stopAttendanceLogsWatch) {
    IX.stopAttendanceLogsWatch();
    IX.stopAttendanceLogsWatch = null;
  }
  if (IX.stopMySeatNotificationWatch) {
    IX.stopMySeatNotificationWatch();
    IX.stopMySeatNotificationWatch = null;
  }
  disposeSeatMapRealtime();
  disposeMyUserProfileRealtime();
}
