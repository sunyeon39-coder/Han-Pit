import { db } from "../firebase.js";
import { buildSeatAssignedNotificationWrite } from "../shared/seat-notification-push.js";
import { doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { syncLayoutGlobalSeatsForCurrentLayout } from "./global-seat-sync.js";
import { globalWaitingDocRef } from "../shared/tournament-waiting-queue.js";
import { diffGlobalWaitingRows } from "../global-layout/waiting-entry-refs.js";

const SAVE_EVENT_DEBOUNCE_MS = 50;
const SAVE_WAITING_DEBOUNCE_MS = 40;

export function createLayoutPersistServices({
  tournamentId,
  eventId,
  boxId,
  eventDocId,
  globalSeatsRef,
  eventRef,
  waitingCollectionRef,
  eventState,
  waitingState,
  clone,
  sanitizeLayoutState,
  isEmptyPerson,
  hasWritableLayoutContext,
  beginLayoutOptimisticMutation,
  endLayoutOptimisticMutation
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
      eventUpdatedAt: Number(eventState?.updatedAt || 0),
      isEmptyPerson
    });
  }

  async function saveEventState() {
    if (!hasWritableLayoutContext()) return;
    // 저장이 서버에 반영될 때까지는 실시간 스냅샷을 신뢰하지 않는다.
    // (로컬에 좌석을 추가/삭제한 직후, 아직 저장이 끝나기 전에 구버전 스냅샷이 도착하면
    //  방금 만든 좌석 박스가 통째로 사라져 보이는 사고를 방지)
    if (typeof beginLayoutOptimisticMutation === "function") beginLayoutOptimisticMutation();
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
    } finally {
      if (typeof endLayoutOptimisticMutation === "function") endLayoutOptimisticMutation();
    }
  }

  async function saveWaitingState() {
    if (!hasWritableLayoutContext() || !waitingCollectionRef) return;
    if (typeof beginLayoutOptimisticMutation === "function") beginLayoutOptimisticMutation();
    try {
      const sanitizedWaitingState = sanitizeLayoutState({
        seats: clone(eventState.seats),
        waiting: clone(waitingState.waiting)
      });
      const nextRows = sanitizedWaitingState.waiting;
      const prevRows = Array.isArray(waitingState.__serverRows) ? waitingState.__serverRows : [];
      const { toSet, toDelete } = diffGlobalWaitingRows(prevRows, nextRows);

      if (toSet.length || toDelete.length) {
        await Promise.all([
          ...toSet.map(({ id, data }) =>
            setDoc(
              globalWaitingDocRef(db, tournamentId, id),
              { ...data, updatedAt: Date.now(), updatedAtServer: serverTimestamp() },
              { merge: true }
            )
          ),
          ...toDelete.map((id) => deleteDoc(globalWaitingDocRef(db, tournamentId, id)))
        ]);
      }

      waitingState.__serverRows = nextRows.map((r) => ({ ...r }));
    } catch (err) {
      console.error("saveWaitingState error:", err);
    } finally {
      if (typeof endLayoutOptimisticMutation === "function") endLayoutOptimisticMutation();
    }
  }

  async function writeUserNotification(payload) {
    if (!hasWritableLayoutContext()) return;
    if (!payload?.uid) return;

    const uid = String(payload.uid || "").trim();
    const isSeatAssigned = String(payload.type || "").trim() === "seat_assigned";
    const body = isSeatAssigned
      ? {
          ...buildSeatAssignedNotificationWrite(uid, payload),
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        }
      : {
          ...payload,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        };

    try {
      await setDoc(doc(db, "layout_notifications", uid), body, { merge: true });
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
