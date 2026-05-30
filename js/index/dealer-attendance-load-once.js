import { auth } from "../firebase.js";
import { getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";

import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef, parseTournamentIdFromAttendanceDocId } from "./dealer-attendance-refs.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

export async function loadDealerAttendanceOnce() {
  IX.dealerAttendanceMap.clear();

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
      filterAttendanceDocsForTournament(snap.docs, adminTournamentId).forEach((d) => {
        const data = d.data() || {};
        const tid =
          parseTournamentIdFromAttendanceDocId(d.id) || String(data.tournamentId || "").trim();
        IX.dealerAttendanceMap.set(d.id, {
          uid: String(data.uid || "").trim(),
          nickname: String(data.nickname || "").trim(),
          email: String(data.email || "").trim(),
          tournamentId: tid,
          status: String(data.status || "off").trim(),
          checkedInAt: Number(data.checkedInAt || 0) || null,
          checkedOutAt: Number(data.checkedOutAt || 0) || null,
          breakStartedAt: Number(data.breakStartedAt || 0) || null,
          totalBreakMs: Number(data.totalBreakMs || 0) || 0,
          currentEventId: String(data.currentEventId || "").trim(),
          currentBoxId: String(data.currentBoxId || "").trim(),
          currentSeatId: String(data.currentSeatId || "").trim(),
          currentSeatLabel: String(data.currentSeatLabel || "").trim(),
          updatedAt: Number(data.updatedAt || 0) || 0
        });
      });
    } else {
      const snap = await getDoc(getAttendanceRef(tournamentId, user.uid));

      if (snap.exists()) {
        const data = snap.data() || {};
        IX.dealerAttendanceMap.set(snap.id, {
          uid: String(data.uid || "").trim(),
          nickname: String(data.nickname || "").trim(),
          email: String(data.email || "").trim(),
          tournamentId: String(data.tournamentId || "").trim(),
          status: String(data.status || "off").trim(),
          checkedInAt: Number(data.checkedInAt || 0) || null,
          checkedOutAt: Number(data.checkedOutAt || 0) || null,
          breakStartedAt: Number(data.breakStartedAt || 0) || null,
          totalBreakMs: Number(data.totalBreakMs || 0) || 0,
          currentEventId: String(data.currentEventId || "").trim(),
          currentBoxId: String(data.currentBoxId || "").trim(),
          currentSeatId: String(data.currentSeatId || "").trim(),
          currentSeatLabel: String(data.currentSeatLabel || "").trim(),
          updatedAt: Number(data.updatedAt || 0) || 0
        });
      }
    }

    scheduleRenderDealerOps();
  } catch (err) {
    console.error("loadDealerAttendanceOnce error:", err);
  }
}
