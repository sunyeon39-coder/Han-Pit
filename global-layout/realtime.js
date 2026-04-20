import { db } from "../firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";
import { renderSeats, renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";

export function bindRealtime() {
  if (!GL.tournamentId) {
    alert("대회 정보가 없습니다.");
    location.replace("./index.html");
    return;
  }

  sessionStorage.setItem("tournamentId", GL.tournamentId);

  if (GL.stopSeatWatch) GL.stopSeatWatch();
  GL.stopSeatWatch = onSnapshot(
    collection(db, "tournaments", GL.tournamentId, "global_seats"),
    (snap) => {
      GL.globalSeats = snap.docs.map((d) => d.data() || {});
      renderSeats(GL.globalSeats);
      if (GL.activeTab === "seat") renderSeatPanel();
      if (GL.activeTab === "wait") {
        renderWaiting(getCurrentTournamentWaiting());
      }
    },
    (err) => {
      console.error("global seats watch error:", err);
      if (String(err?.code || "").includes("permission-denied") && !GL.hasShownPermissionAlert) {
        GL.hasShownPermissionAlert = true;
        alert("global_seats 권한이 없습니다. Firestore Rules 배포 상태를 확인해주세요.");
      }
    }
  );

  if (GL.stopWaitingWatch) GL.stopWaitingWatch();
  GL.stopWaitingWatch = onSnapshot(
    doc(db, "layout_shared", "global_waiting"),
    (snap) => {
      const data = snap.exists() ? (snap.data() || {}) : {};
      GL.globalWaiting = Array.isArray(data.waiting) ? data.waiting : [];
      const filtered = getCurrentTournamentWaiting();
      GL.waitingCountEl.textContent = `WAIT: ${filtered.length}`;
      renderWaiting(filtered);
    },
    (err) => console.error("global waiting watch error:", err)
  );

  if (GL.stopAttendanceWatch) GL.stopAttendanceWatch();
  GL.stopAttendanceWatch = onSnapshot(
    collection(db, "dealer_attendance"),
    (snap) => {
      GL.attendanceWaiting = snap.docs
        .map((d) => d.data() || {})
        .filter((d) => {
          const tid = String(d.tournamentId || "").trim();
          if (tid !== GL.tournamentId) return false;
          const status = String(d.status || "").trim();
          return status === "waiting" || status === "checked_in";
        });
      renderWaiting(getCurrentTournamentWaiting());
    },
    (err) => {
      console.error("dealer attendance watch error:", err);
    }
  );
}
