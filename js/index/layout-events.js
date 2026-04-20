import { db } from "../firebase.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function getLayoutEventDocByEventAndBox(eventId, boxId) {
  const snap = await getDocs(collection(db, "layout_events"));

  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const sameEvent = String(data.eventId || "").trim() === String(eventId || "").trim();
    const sameBox = String(data.boxId || "").trim() === String(boxId || "").trim();

    if (sameEvent && sameBox) {
      return {
        ref: docSnap.ref,
        id: docSnap.id,
        data
      };
    }
  }

  return null;
}
