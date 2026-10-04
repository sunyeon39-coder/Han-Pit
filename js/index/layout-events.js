import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * layout_events 문서는 `${eventId}__${boxId}` ID 로 만들어진다 — 예전엔 매번 컬렉션 전체(모든 대회)를
 * 읽어 찾았는데, 그 ID 로 바로 읽고 없을 때만 eventId 조건 쿼리로 찾는다.
 */
export async function getLayoutEventDocByEventAndBox(eventId, boxId) {
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!eid) return null;

  if (bid) {
    const ref = doc(db, "layout_events", `${eid}__${bid}`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() || {};
      if (String(data.eventId || eid).trim() === eid && String(data.boxId || bid).trim() === bid) {
        return { ref, id: snap.id, data };
      }
    }
  }

  const snap = await getDocs(query(collection(db, "layout_events"), where("eventId", "==", eid)));
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    if (String(data.boxId || "").trim() === bid) {
      return { ref: docSnap.ref, id: docSnap.id, data };
    }
  }

  return null;
}
