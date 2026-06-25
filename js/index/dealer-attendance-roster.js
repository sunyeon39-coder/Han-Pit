import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

function normalizeRosterUser(docSnap) {
  const data = docSnap.data() || {};
  return {
    uid: docSnap.id,
    nickname: String(data.nickname || "").trim(),
    email: String(data.email || "").trim()
  };
}

/** 대회 접근 코드와 일치하는 등록 근무자(미출근 포함) */
export async function loadTournamentDealerRosterOnce() {
  const tournamentId = getTournamentId();
  const requiredCode = String(IX.currentTournament?.requiredCode || "").trim();
  if (!tournamentId || !requiredCode) {
    return;
  }

  const cacheKey = `${tournamentId}:${requiredCode}`;
  if (IX.tournamentRosterLoadKey === cacheKey && IX.tournamentRosterMap.size > 0) {
    return;
  }

  try {
    const snap = await getDocs(
      query(collection(db, "users"), where("accessCode", "==", requiredCode))
    );
    IX.tournamentRosterMap.clear();
    snap.docs.forEach((d) => {
      const row = normalizeRosterUser(d);
      if (row.uid) IX.tournamentRosterMap.set(row.uid, row);
    });
    IX.tournamentRosterLoadKey = cacheKey;
    scheduleRenderDealerOps();
  } catch (err) {
    console.warn("loadTournamentDealerRosterOnce:", err?.code || err);
  }
}
