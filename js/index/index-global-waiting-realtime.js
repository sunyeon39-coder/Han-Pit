import { db } from "../firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

export function bindIndexGlobalWaitingRealtime() {
  if (IX.stopGlobalWaitingWatch) {
    IX.stopGlobalWaitingWatch();
    IX.stopGlobalWaitingWatch = null;
  }

  const tournamentId = getTournamentId();
  if (!tournamentId) {
    IX.globalWaiting = [];
    return;
  }

  IX.stopGlobalWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      const data = snap.exists() ? snap.data() || {} : {};
      IX.globalWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      scheduleRenderDealerOps();
    },
    (err) => {
      console.error("bindIndexGlobalWaitingRealtime error:", err);
    }
  );
}
