import { doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { buildGlobalSeatDocId, isEmptyPerson } from "./utils.js";

/**
 * 배치/해제 시 "같은 사람이 이미 앉은 다른 좌석"만 tx.get 하도록 좁힌다.
 */
export function getCandidateSeatRefsForPerson(db, tournamentId, globalSeats, person = {}, excludeSeatId = "") {
  const waitingUid = String(person.uid || "").trim();
  const waitingEmail = String(person.email || "").trim().toLowerCase();
  const waitingName = String(person.name || "").trim();
  if (!waitingUid && !waitingEmail && !waitingName) return [];

  const ex = String(excludeSeatId || "").trim();
  const refs = [];
  const seen = new Set();

  for (const s of globalSeats) {
    const sid = String(s?.seatId || "").trim();
    if (!sid || sid === ex) continue;

    const e = String(s?.currentEventId || s?.mappedEventId || "").trim();
    const b = String(s?.boxId || "").trim();
    if (!e || !b) continue;

    const pName = String(s?.person || "").trim();
    if (!pName || isEmptyPerson(pName)) continue;

    const pUid = String(s?.personUid || "").trim();
    const pEmail = String(s?.personEmail || "").trim().toLowerCase();
    const sameUser =
      (waitingUid && pUid && waitingUid === pUid) ||
      (waitingEmail && pEmail && waitingEmail === pEmail) ||
      (!waitingUid && !waitingEmail && waitingName && pName === waitingName);
    if (!sameUser) continue;

    const docId = buildGlobalSeatDocId(e, b, sid);
    if (seen.has(docId)) continue;
    seen.add(docId);
    refs.push(doc(db, "tournaments", tournamentId, "global_seats", docId));
  }

  return refs;
}
