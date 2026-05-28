import { db } from "../firebase.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { syncLayoutGlobalSeatsForCurrentLayout } from "./global-seat-sync.js";

const SAVE_EVENT_DEBOUNCE_MS = 90;
const SAVE_WAITING_DEBOUNCE_MS = 55;

export function createLayoutPersistServices({
  tournamentId,
  eventId,
  boxId,
  eventDocId,
  globalSeatsRef,
  eventRef,
  waitingRef,
  eventState,
  waitingState,
  clone,
  sanitizeLayoutState,
  isEmptyPerson,
  hasWritableLayoutContext
}) {
  let saveEventTimer = null;
  let saveWaitingTimer = null;

  async function syncGlobalSeatsForCurrentLayout(seats = []) {
    if (!hasWritableLayoutContext() || !globalSeatsRef) return;
    await syncLayoutGlobalSeatsForCurrentLayout({
      tournamentId,
      eventId,
      boxId,
      eventDocId,
      seats,
      eventUpdatedAt: Number(eventState?.updatedAt || 0) || Date.now(),
      isEmptyPerson
    });
  }

  async function saveEventState() {
    if (!hasWritableLayoutContext()) return;
    try {
      const sanitizedEventState = sanitizeLayoutState({
        seats: clone(eventState.seats),
        waiting: []
      });

      await Promise.all([
        setDoc(
          eventRef,
          {
            ...clone(eventState),
            seats: sanitizedEventState.seats,
            updatedAt: Date.now(),
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        ),
        syncGlobalSeatsForCurrentLayout(sanitizedEventState.seats)
      ]);
    } catch (err) {
      console.error("saveEventState error:", err);
    }
  }

  async function saveWaitingState() {
    if (!hasWritableLayoutContext()) return;
    try {
      const sanitizedWaitingState = sanitizeLayoutState({
        seats: clone(eventState.seats),
        waiting: clone(waitingState.waiting)
      });

      await setDoc(
        waitingRef,
        {
          ...clone(waitingState),
          waiting: sanitizedWaitingState.waiting,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("saveWaitingState error:", err);
    }
  }

  async function writeUserNotification(payload) {
    if (!hasWritableLayoutContext()) return;
    if (!payload?.uid) return;

    try {
      await setDoc(
        doc(db, "layout_notifications", payload.uid),
        {
          ...payload,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("writeUserNotification error:", err);
    }
  }

  async function clearUserSeatNotification(uid, reason = "seat_cleared") {
    if (!uid) return;

    try {
      await setDoc(
        doc(db, "layout_notifications", uid),
        {
          type: reason,
          acknowledged: true,
          seatId: "",
          seatLabel: "",
          eventId: "",
          eventTitle: "",
          boxId: "",
          targetUrl: "",
          message: "",
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error("clearUserSeatNotification error:", err);
    }
  }

  function flushEventSaveNow() {
    if (saveEventTimer) {
      clearTimeout(saveEventTimer);
      saveEventTimer = null;
    }
    eventState.updatedAt = Date.now();
    void saveEventState();
  }

  function flushWaitingSaveNow() {
    if (saveWaitingTimer) {
      clearTimeout(saveWaitingTimer);
      saveWaitingTimer = null;
    }
    waitingState.updatedAt = Date.now();
    void saveWaitingState();
  }

  function touchEvent(immediate = false) {
    eventState.updatedAt = Date.now();

    if (immediate) {
      flushEventSaveNow();
      return;
    }

    if (saveEventTimer) clearTimeout(saveEventTimer);
    saveEventTimer = setTimeout(() => {
      saveEventTimer = null;
      void saveEventState();
    }, SAVE_EVENT_DEBOUNCE_MS);
  }

  function touchWaiting(immediate = false) {
    waitingState.updatedAt = Date.now();

    if (immediate) {
      flushWaitingSaveNow();
      return;
    }

    if (saveWaitingTimer) clearTimeout(saveWaitingTimer);
    saveWaitingTimer = setTimeout(() => {
      saveWaitingTimer = null;
      void saveWaitingState();
    }, SAVE_WAITING_DEBOUNCE_MS);
  }

  return {
    saveEventState,
    saveWaitingState,
    writeUserNotification,
    clearUserSeatNotification,
    flushEventSaveNow,
    flushWaitingSaveNow,
    touchEvent,
    touchWaiting
  };
}
