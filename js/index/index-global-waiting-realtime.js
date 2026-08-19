import { db } from "../firebase.js";
import { onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { globalWaitingCollectionRef } from "../shared/tournament-waiting-queue.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import { writeIndexGlobalWaitingCache } from "./index-ops-session-cache.js";
import { bootstrapIndexDealerOps } from "./index-ops-bootstrap.js";

function shouldKeepCachedGlobalWaiting(snap, nextWaiting = []) {
  if (snap?.metadata?.hasPendingWrites) return false;
  if (!snap?.metadata?.fromCache) return false;
  if (!IX.globalWaiting.length) return false;
  if (snap.empty) return true;
  return nextWaiting.length === 0;
}

function shouldRefreshWaitingFromServer(snap, nextWaiting = []) {
  if (!snap?.metadata?.fromCache) return false;
  return snap.empty || nextWaiting.length === 0;
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
    globalWaitingCollectionRef(db, tournamentId),
    (snap) => {
      const nextWaiting = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
