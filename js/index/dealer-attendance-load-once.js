import { auth } from "../firebase.js";
import { getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef, parseTournamentIdFromAttendanceDocId } from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import { maybeResetMyStaleOperationalDayAttendance } from "./dealer-attendance-operational-day-reset.js";
import { loadTournamentDealerRosterOnce } from "./dealer-attendance-roster.js";

export async function loadDealerAttendanceOnce() {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!tournamentId || !user) return;

  try {
    if (canUseTournamentOps(user?.email, IX.currentUserProfile, tournamentId)) {
      const adminTournamentId = getTournamentId();
      if (!adminTournamentId) {
        scheduleRenderDealerOps();
        return;
      }

      const snap = await getDocs(dealerAttendanceQueryForTournament(adminTournamentId));
      IX.dealerAttendanceMap.clear();
      filterAttendanceDocsForTournament(snap.docs, adminTournamentId).forEach((d) => {
        const data = d.data() || {};
        const tid =
          parseTournamentIdFromAttendanceDocId(d.id) || String(data.tournamentId || "").trim();
        IX.dealerAttendanceMap.set(
          d.id,
          normalizeAttendanceDoc({ ...data, tournamentId: tid, uid: String(data.uid || d.id.split("__").pop() || "").trim() })
        );
      });
      void loadTournamentDealerRosterOnce();
    } else {
      const snap = await getDoc(getAttendanceRef(tournamentId, user.uid));

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
}
