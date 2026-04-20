import { db } from "../firebase.js";
import {
  doc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { isTournamentActive } from "./time-utils.js";
import { IX } from "./state.js";

/* ===============================
   TOURNAMENT PERIOD GUARD
=============================== */
function routeToHub(message) {
  if (IX.periodBlocked) return;
  IX.periodBlocked = true;

  if (message) alert(message);
  location.replace("./hub.html");
}

async function initTournamentPeriodWatch() {
  const tournamentId = getTournamentId();

  if (!tournamentId) {
    if (IX.topbarTournamentName) {
      IX.topbarTournamentName.textContent = "Tournament Events";
    }
    return;
  }

  sessionStorage.setItem("tournamentId", tournamentId);

  const tournamentRef = doc(db, "tournaments", tournamentId);

  try {
    const snap = await getDoc(tournamentRef);

    if (!snap.exists()) {
      if (IX.topbarTournamentName) {
        IX.topbarTournamentName.textContent = "Tournament Events";
      }
      return;
    }

    IX.currentTournament = {
      id: snap.id,
      ...(snap.data() || {})
    };

    if (IX.topbarTournamentName) {
      IX.topbarTournamentName.textContent = IX.currentTournament.name || "Tournament Events";
    }

    if (!isTournamentActive(IX.currentTournament)) {
      routeToHub("대회 기간이 아니거나 종료되어 허브로 이동합니다.");
      return;
    }

    IX.stopTournamentWatch = onSnapshot(
      tournamentRef,
      (docSnap) => {
        if (!docSnap.exists()) {
          routeToHub("대회 정보가 없어 허브로 이동합니다.");
          return;
        }

        IX.currentTournament = {
          id: docSnap.id,
          ...(docSnap.data() || {})
        };

        if (IX.topbarTournamentName) {
          IX.topbarTournamentName.textContent = IX.currentTournament.name || "Tournament Events";
        }

        if (!isTournamentActive(IX.currentTournament)) {
          routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
        }
      },
      (error) => {
        console.error("❌ tournament watch error:", error);
      }
    );
  } catch (error) {
    console.error("❌ initTournamentPeriodWatch error:", error);
  }
}

export { routeToHub, initTournamentPeriodWatch };
