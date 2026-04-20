import { db } from "../firebase.js";
import { collection, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { normalizeEvents, buildSeatSummaryMap, buildSeatSummaryMapFromGlobalSeats } from "./event-cards-model.js";
import { getEventsCollectionRef } from "./event-cards-firestore-refs.js";
import { render, refreshCardStatuses } from "./event-cards-render.js";
import { populateEventSelect, renderEventAdminList } from "./event-cards-admin-form.js";

export async function loadEvents() {
  const tournamentId = getTournamentId();
  if (!tournamentId) {
    IX.events = [];
    return;
  }
  try {
    const snap = await getDocs(getEventsCollectionRef());
    IX.events = normalizeEvents(snap.docs);
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
      render();
      refreshCardStatuses();

      if (IX.eventCardSelect && IX.eventAdminModal?.classList.contains("show")) {
        const selectedId = IX.eventCardId?.value?.trim() || IX.eventCardSelect.value || "";
        populateEventSelect(selectedId);
        renderEventAdminList();
      }
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
        render();
        refreshCardStatuses();
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
      render();
      refreshCardStatuses();
    },
    (err) => {
      console.error("bindLayoutSeatSummaryRealtime(layout_events) error:", err);
    }
  );
}
