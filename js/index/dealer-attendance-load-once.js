import { auth, db } from "../firebase.js";
import { collection, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef, attendanceDocBelongsToTournament, parseTournamentIdFromAttendanceDocId } from "./dealer-attendance-refs.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

export async function loadDealerAttendanceOnce() {
  IX.dealerAttendanceMap.clear();

  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!tournamentId || !user) return;

  try {
    if (getIsAdmin(user, IX.currentUserProfile)) {
      const snap = await getDocs(collection(db, "dealer_attendance"));

      snap.docs.forEach((d) => {
        if (!attendanceDocBelongsToTournament(d.id, tournamentId)) return;
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
