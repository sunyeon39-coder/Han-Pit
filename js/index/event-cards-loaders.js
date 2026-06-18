import { auth, db } from "../firebase.js";
import {
  collection,
  getDocs,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { normalizeEvents, buildSeatSummaryMap, buildSeatSummaryMapFromGlobalSeats } from "./event-cards-model.js";
import { getEventsCollectionRef } from "./event-cards-firestore-refs.js";
import { scheduleIndexCardsRender } from "./index-realtime-ui.js";
import {
  readIndexEventsSessionCache,
  writeIndexEventsSessionCache
} from "./index-events-session-cache.js";
import { applyIndexGlobalSeatsSnapshot } from "./dealer-attendance-realtime.js";

/** 허브→인덱스 직후 Firestore 응답 전 카드 목록 즉시 표시 */
export function seedIndexEventsFromSessionCache() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;
  const cached = readIndexEventsSessionCache(tournamentId);
  if (!cached?.length) return false;
  IX.events = cached;
  return true;
}

/** 허브에서 대회 카드 hover 시 Firestore 캐시·sessionStorage 워밍 */
export function prefetchIndexEventsCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return Promise.resolve();
  return getDocs(collection(db, "tournaments", tid, "events"))
    .then((snap) => {
      if (!snap.empty) {
        writeIndexEventsSessionCache(tid, normalizeEvents(snap.docs));
      }
    })
    .catch((err) => {
      console.warn("prefetchIndexEventsCache:", err?.code || err);
    });
}

export async function loadEvents() {
  const tournamentId = getTournamentId();
  if (!tournamentId) {
    IX.events = [];
    return;
  }
  try {
    const snap = await getDocs(getEventsCollectionRef());
    IX.events = normalizeEvents(snap.docs);
    if (IX.events.length) writeIndexEventsSessionCache(tournamentId, IX.events);
  } catch (err) {
    console.error("loadEvents error:", err);
    IX.events = [];
  }
}

export function bindEventsRealtime() {
  if (IX.stopEventsWatch) {
    IX.stopEventsWatch();
    IX.stopEventsWatch = null;
  }

  const tournamentId = getTournamentId();
  if (!tournamentId) {
    console.warn("bindEventsRealtime: missing tournamentId, skip subscription");
    return;
  }

  IX.stopEventsWatch = onSnapshot(
    getEventsCollectionRef(),
    (snap) => {
      IX.events = normalizeEvents(snap.docs);
      if (IX.events.length) writeIndexEventsSessionCache(tournamentId, IX.events);
      scheduleIndexCardsRender({
        adminForm: IX.eventAdminModal?.classList.contains("show")
      });
    },
    (err) => {
      console.error("bindEventsRealtime error:", err);
    }
  );
}

export function bindLayoutSeatSummaryRealtime() {
  if (IX.stopLayoutEventsWatch) {
    IX.stopLayoutEventsWatch();
    IX.stopLayoutEventsWatch = null;
  }

  const tournamentId = getTournamentId();
  if (tournamentId) {
    IX.stopLayoutEventsWatch = onSnapshot(
      collection(db, "tournaments", tournamentId, "global_seats"),
      (snap) => {
        IX.seatSummaryMap = buildSeatSummaryMapFromGlobalSeats(snap.docs);
        applyIndexGlobalSeatsSnapshot(snap);
        scheduleIndexCardsRender({ light: true });
      },
      (err) => {
        console.error("bindLayoutSeatSummaryRealtime(global) error:", err);
      }
    );
    return;
  }

  IX.stopLayoutEventsWatch = onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      IX.seatSummaryMap = buildSeatSummaryMap(snap.docs);
      scheduleIndexCardsRender({ light: true });
    },
    (err) => {
      console.error("bindLayoutSeatSummaryRealtime(layout_events) error:", err);
    }
  );
}
