import { db } from "../firebase.js";
import { collection, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export { FCM_VAPID_KEY as VAPID_KEY } from "../shared/fcm-web-push.js";
export const ALERT_VOLUME = 0.4;
export const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

export function layoutGetParam(name) {
  const params = new URLSearchParams(location.search);
  return params.get(name) || sessionStorage.getItem(name) || "";
}

export function layoutIsMobile() {
  return window.innerWidth <= 1180;
}

/**
 * layout.html 진입 시 한 번만 쓰는 라우트·Firestore 참조
 */
export function createLayoutMainRouteEnv() {
  const TOURNAMENT_ID = layoutGetParam("tournamentId") || "";
  const EVENT_ID = layoutGetParam("eventId") || "";
  const BOX_ID = layoutGetParam("boxId") || "";
  const FOCUS_SEAT_ID = layoutGetParam("focusSeatId") || "";

  const EVENT_DOC_ID = `${EVENT_ID}__${BOX_ID}`;
  const LAYOUT_CANVAS_VIEW_KEY = `layout_canvas_view_v1_${EVENT_DOC_ID}`;
  const EVENT_REF = doc(db, "layout_events", EVENT_DOC_ID);
  const WAITING_REF = doc(db, "layout_shared", "global_waiting");
  const GLOBAL_SEATS_REF = TOURNAMENT_ID
    ? collection(db, "tournaments", TOURNAMENT_ID, "global_seats")
    : null;

  function getCurrentTournamentId() {
    return (
      new URLSearchParams(location.search).get("tournamentId") ||
      sessionStorage.getItem("tournamentId") ||
      ""
    );
  }

  function isValidDocId(id = "") {
    const value = String(id || "").trim();
    return !!value && !value.includes("/");
  }

  function hasValidLayoutRouteContext() {
    return (
      !!(TOURNAMENT_ID && EVENT_ID && BOX_ID) &&
      isValidDocId(EVENT_ID) &&
      isValidDocId(BOX_ID)
    );
  }

  function hasWritableLayoutContext() {
    return !!(TOURNAMENT_ID && EVENT_ID && BOX_ID);
  }

  return {
    TOURNAMENT_ID,
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    EVENT_DOC_ID,
    LAYOUT_CANVAS_VIEW_KEY,
    EVENT_REF,
    WAITING_REF,
    GLOBAL_SEATS_REF,
    getCurrentTournamentId,
    isValidDocId,
    hasValidLayoutRouteContext,
    hasWritableLayoutContext
  };
}
