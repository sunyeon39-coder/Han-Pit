import { db } from "../firebase.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function getAttendanceDocId(tournamentId, uid) {
  return `${tournamentId}__${uid}`;
}

export function getAttendanceRef(tournamentId, uid) {
  return doc(db, "dealer_attendance", getAttendanceDocId(tournamentId, uid));
}

/** `tournamentId` 필드가 비어 있거나 잘못돼도 Firestore 문서 ID가 진실 원천 */
export function parseTournamentIdFromAttendanceDocId(docId) {
  const id = String(docId || "");
  const marker = "__";
  const idx = id.indexOf(marker);
  if (idx <= 0) return "";
  return id.slice(0, idx);
}

export function attendanceDocBelongsToTournament(docId, tournamentId) {
  const tid = String(tournamentId || "").trim();
  if (!tid || !docId) return false;
  return String(docId).startsWith(`${tid}${marker}`);
}
