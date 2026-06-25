import { db } from "../firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import { writeIndexGlobalWaitingCache } from "./index-ops-session-cache.js";
import { bootstrapIndexDealerOps } from "./index-ops-bootstrap.js";

function shouldKeepCachedGlobalWaiting(snap, nextWaiting = []) {
  if (!snap?.metadata?.fromCache) return false;
  if (!IX.globalWaiting.length) return false;
  if (!snap.exists()) return true;
  return nextWaiting.length === 0;
}

function shouldRefreshWaitingFromServer(snap, nextWaiting = []) {
  if (!snap?.metadata?.fromCache) return false;
  return !snap.exists() || nextWaiting.length === 0;
}

export function bindIndexGlobalWaitingRealtime() {
  if (IX.stopGlobalWaitingWatch) {
    IX.stopGlobalWaitingWatch();
    IX.stopGlobalWaitingWatch = null;
  }

  const tournamentId = getTournamentId();
  if (!tournamentId) {
    return;
  }

  IX.stopGlobalWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      const data = snap.exists() ? snap.data() || {} : {};
      const nextWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      if (shouldKeepCachedGlobalWaiting(snap, nextWaiting)) {
        if (shouldRefreshWaitingFromServer(snap, nextWaiting)) {
          void bootstrapIndexDealerOps();
        }
        return;
      }
      IX.globalWaiting = nextWaiting;
      writeIndexGlobalWaitingCache(tournamentId, nextWaiting);
      scheduleRenderDealerOps();

      if (shouldRefreshWaitingFromServer(snap, nextWaiting)) {
        void bootstrapIndexDealerOps();
      }
    },
    (err) => {
      console.error("bindIndexGlobalWaitingRealtime error:", err);
      void bootstrapIndexDealerOps();
    }
  );
}
