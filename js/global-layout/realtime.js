import { db } from "../firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { attendanceDocBelongsToTournament } from "../index/dealer-attendance-refs.js";
import { GL } from "./state.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
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
      GL.globalSeats = snap.docs.map((d) => ({
        ...(d.data() || {}),
        __firestoreDocId: d.id
      }));
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
      updateGlobalLayoutWaitingMeta();
      renderWaiting(filtered);
    },
    (err) => console.error("global waiting watch error:", err)
  );

  if (GL.stopAttendanceWatch) GL.stopAttendanceWatch();
  GL.stopAttendanceWatch = onSnapshot(
    collection(db, "dealer_attendance"),
    (snap) => {
      const inactive = new Set();
      snap.docs.forEach((d) => {
        if (!attendanceDocBelongsToTournament(d.id, GL.tournamentId)) return;
        const data = d.data() || {};
        const uid = String(data.uid || "").trim();
        const status = String(data.status || "").trim();
        if (uid && (status === "checked_out" || status === "off")) inactive.add(uid);
      });
      GL.attendanceInactiveUids = inactive;

      GL.attendanceWaiting = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .filter((row) => {
          if (!attendanceDocBelongsToTournament(row.id, GL.tournamentId)) return false;
          const status = String(row.status || "").trim();
          return status === "waiting" || status === "checked_in";
        })
        .map(({ id: _id, ...rest }) => rest);

      renderWaiting(getCurrentTournamentWaiting());
    },
    (err) => {
      console.error("dealer attendance watch error:", err);
    }
  );
}
