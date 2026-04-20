import { db } from "../firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";

/** tournaments/{tid}/events 스냅샷 → { id, title, boxId }[] */
export async function fetchTournamentEvents() {
  const tid = String(GL.tournamentId || "").trim();
  if (!tid) return [];
  const snap = await getDocs(collection(db, "tournaments", tid, "events"));
  const list = snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      id: d.id,
      title: String(data.title || d.id).trim(),
      boxId: String(data.boxId || "").trim()
    };
  });
  list.sort((a, b) => {
    const ta = a.title || a.id;
    const tb = b.title || b.id;
    if (ta !== tb) return ta.localeCompare(tb, "ko");
    return a.id.localeCompare(b.id);
  });
  return list;
}
