import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  getDocsFromServer,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { normalizeEvents, buildSeatSummaryMap, buildSeatSummaryMapFromGlobalSeats } from "./event-cards-model.js";
import { getEventsCollectionRef } from "./event-cards-firestore-refs.js";
import { scheduleIndexCardsRender } from "./index-realtime-ui.js";
import {
  readIndexEventsLegacyCache,
  readIndexEventsPersistedCache,
  writeIndexEventsSessionCache
} from "./index-events-session-cache.js";
import { applyIndexGlobalSeatsSnapshot } from "./dealer-attendance-realtime.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";

function shouldSkipEmptyCacheSnapshot(snap, cachedCount = 0) {
  return Boolean(snap?.empty && snap.metadata?.fromCache && cachedCount > 0);
}

function restoreIndexEventsFromPersistedCache(tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  if (!tid) return false;
  const cached = readIndexEventsPersistedCache(tid) || readIndexEventsLegacyCache(tid);
  if (!cached?.length) return false;
  IX.events = cached;
  return true;
}

function applyEventsSnap(snap, tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  if (!snap || snap.empty) {
    if (snap?.metadata?.fromCache) return IX.events;
    if (IX.events.length > 0) return IX.events;
    restoreIndexEventsFromPersistedCache(tid);
    return IX.events;
  }
  IX.events = normalizeEvents(snap.docs);
  if (IX.events.length && tid) writeIndexEventsSessionCache(tid, IX.events);
  return IX.events;
}

async function refreshEventsFromServer(tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  if (!tid || isFirestoreQuotaCoolingDown()) return;
  try {
    const serverSnap = await getDocsFromServer(getEventsCollectionRef());
    applyEventsSnap(serverSnap, tid);
    scheduleIndexCardsRender({
      adminForm: IX.eventAdminModal?.classList.contains("show")
    });
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshEventsFromServer:", err?.code || err);
    if (!IX.events.length) restoreIndexEventsFromPersistedCache(tid);
  }
}

/** 허브→인덱스 직후 Firestore 응답 전 카드 목록 즉시 표시 */
export function seedIndexEventsFromSessionCache() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;
  return restoreIndexEventsFromPersistedCache(tournamentId);
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

export function upsertIndexEventInCache(event = {}, tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  const id = String(event.id || "").trim();
  if (!tid || !id) return;
  const row = {
    id,
    cardId: String(event.cardId || "").trim(),
    boxId: String(event.boxId || "").trim(),
    date: String(event.date || "").trim(),
    title: String(event.title || id).trim(),
    start: String(event.start || "").trim(),
    close: String(event.close || "").trim()
  };
  const next = (IX.events || []).filter((e) => String(e.id || "") !== id);
  next.push(row);
  IX.events = next.sort((a, b) => {
    const da = String(a.date || "");
    const db = String(b.date || "");
    if (da !== db) return da.localeCompare(db);
    return String(a.start || "").localeCompare(String(b.start || ""));
  });
  writeIndexEventsSessionCache(tid, IX.events);
  scheduleIndexCardsRender({ adminForm: IX.eventAdminModal?.classList.contains("show") });
}

export function removeIndexEventFromCache(eventId = "", tournamentId = "") {
  const tid = String(tournamentId || getTournamentId() || "").trim();
  const id = String(eventId || "").trim();
  if (!tid || !id) return;
  IX.events = (IX.events || []).filter((e) => String(e.id || "") !== id);
  writeIndexEventsSessionCache(tid, IX.events);
  scheduleIndexCardsRender({ adminForm: IX.eventAdminModal?.classList.contains("show") });
}

export async function loadEvents() {
  const tournamentId = getTournamentId();
  if (!tournamentId) {
    IX.events = [];
    return;
  }
  try {
    const cacheSnap = await getDocs(getEventsCollectionRef());
    if (!cacheSnap.empty) {
      applyEventsSnap(cacheSnap, tournamentId);
      if (cacheSnap.metadata?.fromCache) void refreshEventsFromServer(tournamentId);
      return;
    }

    try {
      const serverSnap = await getDocsFromServer(getEventsCollectionRef());
      applyEventsSnap(serverSnap, tournamentId);
    } catch (err) {
      noteFirestoreQuotaExceeded(err);
      console.warn("loadEvents server:", err?.code || err);
      if (!IX.events.length) restoreIndexEventsFromPersistedCache(tournamentId);
    }
  } catch (err) {
    console.error("loadEvents error:", err);
    if (!IX.events.length) restoreIndexEventsFromPersistedCache(tournamentId);
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
      if (shouldSkipEmptyCacheSnapshot(snap, IX.events.length)) return;
      applyEventsSnap(snap, tournamentId);
      scheduleIndexCardsRender({
        adminForm: IX.eventAdminModal?.classList.contains("show")
      });
    },
    (err) => {
      console.error("bindEventsRealtime error:", err);
      if (!IX.events.length) restoreIndexEventsFromPersistedCache(tournamentId);
      scheduleIndexCardsRender({
        adminForm: IX.eventAdminModal?.classList.contains("show")
      });
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
