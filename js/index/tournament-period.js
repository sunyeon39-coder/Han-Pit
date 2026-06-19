import { db } from "../firebase.js";
import {
  doc,
  getDoc,
  getDocFromServer,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId, resolveRelativePage } from "./core-utils.js";
import { isTournamentActive } from "./time-utils.js";
import { IX } from "./state.js";
import { escapeHtml } from "../shared/dom-utils.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";

/* ===============================
   TOURNAMENT PERIOD GUARD
=============================== */
function routeToHub(message) {
  if (IX.periodBlocked) return;
  IX.periodBlocked = true;

  if (message) alert(message);
  location.replace(resolveRelativePage("hub.html"));
}

function showMissingTournamentOnIndex() {
  sessionStorage.removeItem("tournamentId");
  if (IX.topbarTournamentName) {
    IX.topbarTournamentName.textContent = "Tournament Events";
  }
  const hubHref = resolveRelativePage("hub.html");
  if (IX.root) {
    IX.root.innerHTML = `
      <section class="index-boot-card" role="alert">
        <h2 class="index-boot-title">대회를 찾을 수 없습니다</h2>
        <p class="index-boot-desc">Firestore에 해당 대회가 없거나 아직 동기화되지 않았습니다. 허브에서 대회를 다시 저장·선택해 주세요.</p>
        <a class="manage-btn index-boot-btn" href="${escapeHtml(hubHref)}">Han Pit 허브로 이동</a>
      </section>`;
  }
}

function applyTournamentDoc(docSnap) {
  if (!docSnap?.exists()) return false;

  IX.currentTournament = {
    id: docSnap.id,
    ...(docSnap.data() || {})
  };
  window.dispatchEvent(new CustomEvent("hanpit-index-tournament-ready"));

  const tournamentId = getTournamentId();
  if (IX.topbarTournamentName) {
    const name = IX.currentTournament.name || "Tournament Events";
    IX.topbarTournamentName.textContent = name;
    if (tournamentId) sessionStorage.setItem(`tournamentName:${tournamentId}`, name);
  }
  return true;
}

async function readTournamentDoc(ref) {
  let snap = await getDoc(ref);
  if (snap.exists() || snap.metadata?.hasPendingWrites) return snap;

  if (isFirestoreQuotaCoolingDown()) return snap;

  try {
    const serverSnap = await getDocFromServer(ref);
    if (serverSnap.exists()) return serverSnap;
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("readTournamentDoc server:", err?.code || err);
  }
  return snap;
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
    const snap = await readTournamentDoc(tournamentRef);

    if (!snap.exists()) {
      if (snap.metadata?.fromCache) {
        console.warn("[index] tournament cache miss — waiting for realtime/server");
      } else {
        showMissingTournamentOnIndex();
        return;
      }
    } else {
      applyTournamentDoc(snap);

      if (!isTournamentActive(IX.currentTournament)) {
        routeToHub("대회 기간이 아니거나 종료되어 허브로 이동합니다.");
        return;
      }
    }

    if (IX.stopTournamentWatch) {
      IX.stopTournamentWatch();
      IX.stopTournamentWatch = null;
    }

    IX.stopTournamentWatch = onSnapshot(
      tournamentRef,
      (docSnap) => {
        if (!docSnap.exists()) {
          if (docSnap.metadata?.fromCache) return;
          showMissingTournamentOnIndex();
          return;
        }

        applyTournamentDoc(docSnap);

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
