import { db } from "../firebase.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function getAttendanceDocId(tournamentId, uid) {
  return `${tournamentId}__${uid}`;
}

export function getAttendanceRef(tournamentId, uid) {
  return doc(db, "dealer_attendance", getAttendanceDocId(tournamentId, uid));
}
