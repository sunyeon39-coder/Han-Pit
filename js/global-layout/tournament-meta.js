import { db } from "../firebase.js";
import {
  doc,
  getDoc,
  getDocFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";

export function globalLayoutTournamentMeta() {
  const t = GL.currentTournament;
  if (t?.id) {
    return { id: t.id, name: t.name, logoText: t.logoText };
  }
  const tid = String(GL.tournamentId || "").trim();
  if (!tid) return null;
  const cachedName = sessionStorage.getItem(`tournamentName:${tid}`);
  if (cachedName) return { id: tid, name: cachedName, logoText: "" };
  return { id: tid };
}

export async function loadGlobalLayoutTournamentMeta() {
  const tid = String(GL.tournamentId || "").trim();
  if (!tid) return null;

  sessionStorage.setItem("tournamentId", tid);

  const cachedName = sessionStorage.getItem(`tournamentName:${tid}`);
  if (cachedName && !GL.currentTournament?.id) {
    GL.currentTournament = { id: tid, name: cachedName };
  }

  try {
    const ref = doc(db, "tournaments", tid);
    let snap = await getDoc(ref);
    if (!snap.exists() && !snap.metadata?.hasPendingWrites && !isFirestoreQuotaCoolingDown()) {
      try {
        snap = await getDocFromServer(ref);
      } catch (err) {
        noteFirestoreQuotaExceeded(err);
        console.warn("loadGlobalLayoutTournamentMeta server:", err?.code || err);
      }
    }
    if (snap.exists()) {
      GL.currentTournament = { id: snap.id, ...(snap.data() || {}) };
      const name = String(GL.currentTournament.name || "").trim() || "Tournament";
      sessionStorage.setItem(`tournamentName:${tid}`, name);
    }
  } catch (err) {
    console.warn("loadGlobalLayoutTournamentMeta:", err?.code || err);
  }

  return globalLayoutTournamentMeta();
}
