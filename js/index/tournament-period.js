import { db } from "../firebase.js";
import {
  doc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getTournamentId, resolveRelativePage } from "./core-utils.js";
import { isTournamentActive } from "./time-utils.js";
import { IX } from "./state.js";
import { escapeHtml } from "../shared/dom-utils.js";

/* ===============================
   TOURNAMENT PERIOD GUARD
=============================== */
function routeToHub(message) {
  if (IX.periodBlocked) return;
  IX.periodBlocked = true;

  if (message) alert(message);
  location.replace(resolveRelativePage("hub.html"));
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

  const cachedName = sessionStorage.getItem(`tournamentName:${tournamentId}`);
  if (cachedName && IX.topbarTournamentName) {
    IX.topbarTournamentName.textContent = cachedName;
  }

  const tournamentRef = doc(db, "tournaments", tournamentId);

  try {
    const snap = await getDoc(tournamentRef);

    if (!snap.exists()) {
      sessionStorage.removeItem("tournamentId");
      if (IX.topbarTournamentName) {
        IX.topbarTournamentName.textContent = "Tournament Events";
      }
      const hubHref = resolveRelativePage("hub.html");
      if (IX.root) {
        IX.root.innerHTML = `
          <section class="index-boot-card" role="alert">
            <h2 class="index-boot-title">대회를 찾을 수 없습니다</h2>
            <p class="index-boot-desc">저장된 대회 ID가 잘못되었거나 삭제되었을 수 있습니다. 허브에서 다시 선택해 주세요.</p>
            <a class="manage-btn index-boot-btn" href="${escapeHtml(hubHref)}">Han Pit 허브로 이동</a>
          </section>`;
      }
      setTimeout(() => {
        location.href = hubHref;
      }, 400);
      return;
    }

    IX.currentTournament = {
      id: snap.id,
      ...(snap.data() || {})
    };

    if (IX.topbarTournamentName) {
      const name = IX.currentTournament.name || "Tournament Events";
      IX.topbarTournamentName.textContent = name;
      sessionStorage.setItem(`tournamentName:${tournamentId}`, name);
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
          const name = IX.currentTournament.name || "Tournament Events";
          IX.topbarTournamentName.textContent = name;
          sessionStorage.setItem(`tournamentName:${tournamentId}`, name);
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
