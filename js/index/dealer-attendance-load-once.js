import { auth } from "../firebase.js";
import {
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef, parseTournamentIdFromAttendanceDocId } from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import { maybeResetMyStaleOperationalDayAttendance } from "./dealer-attendance-operational-day-reset.js";
import { loadTournamentDealerRosterOnce } from "./dealer-attendance-roster.js";
import { indexCanUseTournamentOps } from "./index-ops-tournament-meta.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";

let loadDealerAttendanceInflight = null;

function applyAttendanceDocs(docs = [], tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  IX.dealerAttendanceMap.clear();
  filterAttendanceDocsForTournament(docs, tid).forEach((d) => {
    const data = d.data() || {};
    const docTid =
      parseTournamentIdFromAttendanceDocId(d.id) || String(data.tournamentId || "").trim();
    IX.dealerAttendanceMap.set(
      d.id,
      normalizeAttendanceDoc({
        ...data,
        tournamentId: docTid,
        uid: String(data.uid || d.id.split("__").pop() || "").trim()
      })
    );
  });
}

export async function loadDealerAttendanceOnce(options = {}) {
  const forceServer = options.forceServer === true;
  if (loadDealerAttendanceInflight) return loadDealerAttendanceInflight;

  loadDealerAttendanceInflight = (async () => {
    const tournamentId = getTournamentId();
    const user = auth.currentUser;
    if (!tournamentId || !user) return;

    try {
      if (indexCanUseTournamentOps(user)) {
        const adminTournamentId = getTournamentId();
        if (!adminTournamentId) {
          scheduleRenderDealerOps();
          return;
        }

        const q = dealerAttendanceQueryForTournament(adminTournamentId);
        let snap = await getDocs(q);
        const shouldFetchServer = forceServer || snap.empty;

        if (shouldFetchServer && !isFirestoreQuotaCoolingDown()) {
          try {
            const serverSnap = await getDocsFromServer(q);
            if (forceServer || serverSnap.size > 0 || snap.empty) {
              snap = serverSnap;
            }
          } catch (err) {
            noteFirestoreQuotaExceeded(err);
            console.warn("loadDealerAttendanceOnce server:", err?.code || err);
          }
        }

        applyAttendanceDocs(snap.docs, adminTournamentId);
        void loadTournamentDealerRosterOnce();
      } else {
        const ref = getAttendanceRef(tournamentId, user.uid);
        let snap = await getDoc(ref);

        if ((forceServer || !snap.exists()) && !isFirestoreQuotaCoolingDown()) {
          try {
            const serverSnap = await getDocFromServer(ref);
            if (forceServer || serverSnap.exists()) snap = serverSnap;
          } catch (err) {
            noteFirestoreQuotaExceeded(err);
            console.warn("loadDealerAttendanceOnce user server:", err?.code || err);
          }
        }

        IX.dealerAttendanceMap.clear();
        if (snap.exists()) {
          IX.dealerAttendanceMap.set(snap.id, normalizeAttendanceDoc(snap.data() || {}));
        }
      }

      await maybeResetMyStaleOperationalDayAttendance(user);
      scheduleRenderDealerOps();
    } catch (err) {
      console.error("loadDealerAttendanceOnce error:", err);
    }
  })().finally(() => {
    loadDealerAttendanceInflight = null;
  });

  return loadDealerAttendanceInflight;
}
