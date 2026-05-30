import { auth, db } from "../firebase.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { IX } from "./state.js";

export async function ensureMyState() {
  const user = auth.currentUser;
  if (!user) return;

  const uid = String(user.uid || "").trim();
  if (!uid) return;

  const seatInfo = IX.dealerSeatMap.get(uid);

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const snap = await getDoc(waitingRef);

  let waitingList = [];
  if (snap.exists()) {
    const data = snap.data() || {};
    waitingList = Array.isArray(data.waiting) ? data.waiting : [];
  }

  const inWaiting = waitingList.some(
    (w) => String(w.uid || "").trim() === uid
  );

  if (!seatInfo && !inWaiting) {
    const nickname =
      String(IX.currentUserProfile?.nickname || user.displayName || "").trim() ||
      String(user.email || "").trim() ||
      "Dealer";

    waitingList.push({
      id: `auto_${uid}`,
      uid,
      email: String(user.email || "").trim(),
      name: nickname,
      addedAt: Date.now()
    });

    await setDoc(
      waitingRef,
      {
        waiting: waitingList,
        updatedAt: Date.now()
      },
      { merge: true }
    );
  }
}
