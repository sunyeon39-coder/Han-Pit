import { db } from "../firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const DEALER_STATUS_COMPARE_KEYS = [
  "email",
  "nickname",
  "status",
  "currentEventId",
  "currentBoxId",
  "currentSeatId",
  "currentSeatLabel"
];

export async function setLayoutDealerStatus(tournamentId, uid, patch = {}) {
  if (!uid || !tournamentId) return;

  try {
    const ref = doc(db, "dealer_attendance", `${tournamentId}__${uid}`);
    await setDoc(
      ref,
      {
        uid,
        tournamentId,
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp(),
        ...patch
      },
      { merge: true }
    );
  } catch (err) {
    console.error("setDealerStatus error:", err);
  }
}

export async function applyLayoutDealerAttendancePatchesBatched(tournamentId, pairs = []) {
  if (!tournamentId) return;

  const dedup = new Map();
  for (const row of pairs) {
    const uid = String(row?.uid || "").trim();
    if (!uid) continue;
    if (dedup.has(uid)) continue;
    dedup.set(uid, row.patch || {});
  }

  const list = Array.from(dedup.entries());
  if (!list.length) return;

  const MAX_CHUNK = 400;

  for (let c = 0; c < list.length; c += MAX_CHUNK) {
    const chunk = list.slice(c, c + MAX_CHUNK);
    const refs = chunk.map(([uid]) => doc(db, "dealer_attendance", `${tournamentId}__${uid}`));
    const snaps = await Promise.all(refs.map((r) => getDoc(r)));

    const batch = writeBatch(db);
    let writes = 0;

    for (let i = 0; i < chunk.length; i++) {
      const [uid, patch] = chunk[i];
      const prev = snaps[i].exists() ? snaps[i].data() || {} : {};
      const next = { uid, tournamentId, ...patch };
      const changed = DEALER_STATUS_COMPARE_KEYS.some(
        (key) => String(prev[key] ?? "") !== String(next[key] ?? "")
      );
      if (!changed) continue;

      batch.set(
        refs[i],
        {
          uid,
          tournamentId,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp(),
          ...patch
        },
        { merge: true }
      );
      writes += 1;
    }

    if (writes) await batch.commit();
  }
}
