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
    // 이름만으로는 매칭하지 않는다 — uid/email 이 둘 다 없는 수동 입력 대기자(워크인)와
    // 동명이인이 이미 다른 좌석에 앉아있으면, 그 사람과 무관한 좌석이 "중복"으로 오인돼
    // 조용히 비워지고 정상적으로 앉아있던 사람이 대기로 밀려나는 문제가 있었다.
    const sameUser =
      (waitingUid && pUid && waitingUid === pUid) ||
      (waitingEmail && pEmail && waitingEmail === pEmail);
    if (!sameUser) continue;

    const docId = buildGlobalSeatDocId(e, b, sid);
    if (seen.has(docId)) continue;
    seen.add(docId);
    refs.push(doc(db, "tournaments", tournamentId, "global_seats", docId));
  }

  return refs;
}
