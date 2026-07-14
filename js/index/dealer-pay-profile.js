import { db } from "../firebase.js";
import { collection, doc, getDocs, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getTournamentId } from "./core-utils.js";

export function defaultPayProfile(uid = "") {
  return {
    uid: String(uid || "").trim(),
    payMode: "hourly",
    hourlyRate: 0,
    dailyRate: 0,
    extras: []
  };
}

function normalizePayProfile(raw = {}, uid = "") {
  const safeUid = String(uid || raw?.uid || "").trim();
  const payMode = String(raw?.payMode || "hourly").trim() === "daily" ? "daily" : "hourly";
  const extras = Array.isArray(raw?.extras)
    ? raw.extras
        .map((item) => ({
          label: String(item?.label || "").trim(),
          amount: Math.max(0, Number(item?.amount || 0) || 0)
        }))
        .filter((item) => item.label || item.amount > 0)
    : [];

  return {
    uid: safeUid,
    payMode,
    hourlyRate: Math.max(0, Number(raw?.hourlyRate || 0) || 0),
    dailyRate: Math.max(0, Number(raw?.dailyRate || 0) || 0),
    extras
  };
}

export async function loadAllPayProfilesForTournament(tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  const map = new Map();
  if (!tid) return map;

  try {
    const snap = await getDocs(collection(db, "tournaments", tid, "dealer_pay_profiles"));
    snap.docs.forEach((d) => {
      map.set(d.id, normalizePayProfile(d.data() || {}, d.id));
    });
  } catch (err) {
    console.warn("loadAllPayProfilesForTournament:", err?.code || err);
  }

  return map;
}

export async function savePayProfile(uid = "", profile = {}) {
  const safeUid = String(uid || profile?.uid || "").trim();
  const tid = String(getTournamentId() || "").trim();
  if (!safeUid || !tid) return false;

  const next = normalizePayProfile(profile, safeUid);
  await setDoc(
    doc(db, "tournaments", tid, "dealer_pay_profiles", safeUid),
    {
      ...next,
      updatedAt: Date.now()
    },
    { merge: true }
  );
  return true;
}
