import { auth, db } from "../firebase.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getIsAdmin } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import {
  getAttendanceDocId,
  getAttendanceRef,
  attendanceDocBelongsToTournament,
  parseTournamentIdFromAttendanceDocId
} from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import { renderDealerOps } from "./dealer-attendance-render.js";
import { ensureMeRecovered } from "./dealer-attendance-recovery.js";

export function bindDealerAttendanceRealtime() {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!tournamentId || !user) return;

  if (IX.stopDealerAttendanceWatch) {
    IX.stopDealerAttendanceWatch();
    IX.stopDealerAttendanceWatch = null;
  }

  if (getIsAdmin(user, IX.currentUserProfile)) {
    IX.stopDealerAttendanceWatch = onSnapshot(
      collection(db, "dealer_attendance"),
      (snap) => {
        IX.dealerAttendanceMap.clear();

        snap.docs.forEach((d) => {
          if (!attendanceDocBelongsToTournament(d.id, tournamentId)) return;
          const raw = d.data() || {};
          const forcedTid = parseTournamentIdFromAttendanceDocId(d.id) || tournamentId;
          const data = normalizeAttendanceDoc({ ...raw, tournamentId: forcedTid });
          IX.dealerAttendanceMap.set(d.id, data);
        });

        renderDealerOps();
      },
      (err) => {
        console.error("bindDealerAttendanceRealtime(admin) error:", err);
      }
    );
    return;
  }

  IX.stopDealerAttendanceWatch = onSnapshot(
    getAttendanceRef(tournamentId, user.uid),
    (snap) => {
      IX.dealerAttendanceMap.delete(getAttendanceDocId(tournamentId, user.uid));

      if (snap.exists()) {
        const data = normalizeAttendanceDoc(snap.data() || {});
        IX.dealerAttendanceMap.set(snap.id, data);
      }

      renderDealerOps();
    },
    (err) => {
      console.error("bindDealerAttendanceRealtime(user) error:", err);
    }
  );
}

export function bindDealerSeatRealtime() {
  if (IX.stopDealerSeatWatch) {
    IX.stopDealerSeatWatch();
    IX.stopDealerSeatWatch = null;
  }

  const tournamentId = getTournamentId();
  if (tournamentId) {
    IX.stopDealerSeatWatch = onSnapshot(
      collection(db, "tournaments", tournamentId, "global_seats"),
      (snap) => {
        IX.dealerSeatMap.clear();

        snap.docs.forEach((d) => {
          const data = d.data() || {};
          const uid = String(data.personUid || "").trim();
          const person = String(data.person || "").trim();
          if (!uid || !person || person === "비어있음") return;
          IX.dealerSeatMap.set(uid, {
            eventId: String(data.currentEventId || data.mappedEventId || "").trim(),
            boxId: String(data.boxId || "").trim(),
            seatId: String(data.seatId || "").trim(),
            seatLabel: String(data.label || data.no || "").trim()
          });
        });

        void ensureMeRecovered(auth.currentUser);
        renderDealerOps();
      },
      (err) => {
        console.error("bindDealerSeatRealtime(global) error:", err);
      }
    );
    return;
  }

  IX.stopDealerSeatWatch = onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      IX.dealerSeatMap.clear();

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const eventId = String(data.eventId || "").trim();
        const boxId = String(data.boxId || "").trim();
        const seats = Array.isArray(data.seats) ? data.seats : [];

        seats.forEach((seat) => {
          const uid = String(seat?.personUid || "").trim();
          const person = String(seat?.person || "").trim();
          if (!uid || !person || person === "비어있음") return;

          IX.dealerSeatMap.set(uid, {
            eventId,
            boxId,
            seatId: String(seat?.id || "").trim(),
            seatLabel: String(seat?.label ?? seat?.no ?? "")
          });
        });
      });

      void ensureMeRecovered(auth.currentUser);
      renderDealerOps();
    },
    (err) => {
      console.error("bindDealerSeatRealtime(layout_events) error:", err);
    }
  );
}
