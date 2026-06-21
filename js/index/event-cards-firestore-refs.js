import { db } from "../firebase.js";
import { collection, doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getTournamentId } from "./core-utils.js";

export function getEventsCollectionRef(tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  if (!tid) {
    throw new Error("getEventsCollectionRef: missing tournamentId");
  }
  return collection(db, "tournaments", tid, "events");
}

export function getEventDocRef(eventId) {
  const tournamentId = getTournamentId();
  if (!tournamentId) {
    throw new Error("getEventDocRef: missing tournamentId");
  }
  return doc(db, "tournaments", tournamentId, "events", eventId);
}
