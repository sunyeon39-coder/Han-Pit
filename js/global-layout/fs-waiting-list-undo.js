import { db } from "../firebase.js";
import {
  deleteDoc,
  doc,
  runTransaction,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import { getAttendanceRef, isEmptyPerson, makeUid, resolveGlobalSeatDocRefForUndo } from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import {
  applyWaitingBlockLocal,
  getCurrentTournamentWaiting,
  replaceGlobalWaitingLocal,
  resolveWaitingEntryById
} from "./waiting.js";
import { flushOptimisticGlobalLayoutUi } from "./optimistic-seat-mutation.js";
import { invalidateWaitingPanelFingerprint } from "./panel-ui.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { clearMyWaitingPick } from "./waiting-picks.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { syncLayoutProjection } from "./fs-layout-projection.js";
import {
  popGlobalUndo,
  popGlobalRedo,
  pushGlobalRedo,
  pushGlobalUndo,
  restoreGlobalRedo,
  restoreGlobalUndo
} from "./undo-stack.js";
import { markGlobalLayoutLocalMutation, markSkipSeatRecovery } from "./layout-mutation-guard.js";

function resolveUndoSeatRef(payload = {}) {
  const ref = resolveGlobalSeatDocRefForUndo(payload, GL.tournamentId);
  if (!ref) throw new Error("seat_not_found");
  return ref;
}

function removeSeatFromGlobalLayoutLocal(payload = {}) {
  const seatId = String(payload.targetSeatId || payload.seatId || "").trim();
  const docId = String(payload.firestoreDocId || "").trim();
  if (!seatId && !docId) return;

  GL.globalSeats = GL.globalSeats.filter((seat) => {
    const sid = String(seat?.seatId || "").trim();
    const cachedId = String(seat?.__firestoreDocId || "").trim();
    if (docId && cachedId === docId) return false;
    if (seatId && sid === seatId && (!docId || cachedId === docId || !cachedId)) return false;
    return true;
  });

  if (seatId) GL.selectedSeatIds.delete(seatId);
  if (docId) GL.selectedSeatIds.delete(docId);
}

function resetGlobalLayoutSelectionAfterUndo(snap = null) {
  if (!snap || typeof snap !== "object") return;
  if (snap.kind === "assign" || snap.kind === "clear_seat" || snap.kind === "add_seat") {
    GL.selectedWaitingId = "";
    void clearMyWaitingPick();
  }
}

function appendSeatShellFields(fields = {}, payload = {}) {
  const shell =
    payload.seatSnapshot && typeof payload.seatSnapshot === "object" ? payload.seatSnapshot : null;
  if (!shell) return fields;

  const out = { ...fields };
  const label = String(shell.label ?? shell.no ?? "").trim();
  if (label) {
    out.label = label;
    out.no = Number(shell.no ?? shell.order ?? label) || out.no;
  }
  if (shell.order != null && Number.isFinite(Number(shell.order))) {
    out.order = Number(shell.order);
  }
  if (shell.x != null && Number.isFinite(Number(shell.x))) out.x = Number(shell.x);
  if (shell.y != null && Number.isFinite(Number(shell.y))) out.y = Number(shell.y);
  const seatId = String(shell.seatId || payload.seatId || payload.targetSeatId || "").trim();
  if (seatId) out.seatId = seatId;
  return out;
}

function resolveAssignedSeatedAt(payload = {}, fallbackMs = Date.now()) {
  const ms = Number(payload.assignedSeatedAt || payload.assignSeatedAt || 0);
  return Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
}

function resolveWaitingJoinedAt(payload = {}, waitingRow = {}, fallbackMs = Date.now()) {
  const waitingBefore = Array.isArray(payload.waitingBefore) ? payload.waitingBefore : [];
  const wid = String(waitingRow.id || "").trim();
  const wUid = String(waitingRow.uid || "").trim();
  const wEmail = String(waitingRow.email || "").trim();
  const wName = String(waitingRow.name || "").trim();

  const fromBefore = waitingBefore.find((w) => {
    if (!w || typeof w !== "object") return false;
    const rowId = String(w.id || "").trim();
    const rowUid = String(w.uid || "").trim();
    const rowEmail = String(w.email || "").trim();
    const rowName = String(w.name || "").trim();
    if (wid && rowId === wid) return true;
    if (wUid && rowUid && rowUid === wUid) return true;
    if (wEmail && rowEmail && rowEmail === wEmail) return true;
    if (!wUid && !wEmail && wName && rowName === wName) return true;
    return false;
  });

  if (fromBefore) {
    const preserved = Number(
      fromBefore.joinedAt || fromBefore.addedAt || fromBefore.createdAt || 0
    );
    if (Number.isFinite(preserved) && preserved > 0) return preserved;
  }

  const direct = Number(waitingRow.joinedAt || waitingRow.addedAt || waitingRow.createdAt || 0);
  return Number.isFinite(direct) && direct > 0 ? direct : fallbackMs;
}

function resolveReturnedJoinedAt(payload = {}, fallbackMs = Date.now()) {
  const ms = Number(payload.returnedJoinedAt || 0);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  const seatedAt = Number(seatBefore?.seatedAt || 0);
  if (Number.isFinite(seatedAt) && seatedAt > 0) return seatedAt;
  return fallbackMs;
}

function beginUndoRedoMutation() {
  markGlobalLayoutLocalMutation();
  markSkipSeatRecovery();
  GL.waitingMutationInFlight = true;
}

function endUndoRedoMutation() {
  GL.waitingMutationInFlight = false;
}

function applySeatSnapshotToGlobalSeats(snapshot = {}, firestoreDocId = "") {
  const seatId = String(snapshot.seatId || "").trim();
  if (!seatId) return;

  const docId = String(firestoreDocId || snapshot.__firestoreDocId || "").trim();
  const label = String(snapshot.label ?? snapshot.no ?? seatId).trim();
  const order = Number(snapshot.order ?? snapshot.no ?? 0) || 0;
  const row = {
    ...snapshot,
    seatId,
    label,
    no: Number(snapshot.no ?? order) || order,
    order,
    __firestoreDocId: docId || snapshot.__firestoreDocId || ""
  };

  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === seatId);
  if (idx >= 0) GL.globalSeats[idx] = { ...GL.globalSeats[idx], ...row };
  else GL.globalSeats.push(row);
}

function syncGlobalSeatFromAssignPayload(payload = {}, mode = "undo") {
  const sid = String(payload.targetSeatId || "").trim();
  if (!sid) return;

  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === sid);
  if (idx < 0) return;

  const row = { ...GL.globalSeats[idx] };
  if (payload.seatSnapshot && typeof payload.seatSnapshot === "object") {
    Object.assign(row, payload.seatSnapshot);
  }

  if (mode === "undo") {
    const before = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
    if (before && !isEmptyPerson(String(before.person || "").trim())) {
      row.person = String(before.person || "").trim();
      row.personUid = String(before.personUid || "").trim();
      row.personEmail = String(before.personEmail || "").trim();
      row.seatedAt = before.seatedAt ? Number(before.seatedAt) : null;
      row.status = String(before.status || "").trim() || "occupied";
    } else {
      row.person = "비어있음";
      row.personUid = "";
      row.personEmail = "";
      row.seatedAt = null;
      row.status = "empty";
    }
  } else {
    const waiting = payload.waiting && typeof payload.waiting === "object" ? payload.waiting : {};
    row.person = String(waiting.name || "").trim();
    row.personUid = String(waiting.uid || "").trim();
    row.personEmail = String(waiting.email || "").trim();
    row.seatedAt = resolveAssignedSeatedAt(payload);
    row.status = "occupied";
  }

  GL.globalSeats[idx] = row;
}

function syncGlobalSeatFromClearPayload(payload = {}, mode = "undo") {
  const sid = String(payload.targetSeatId || "").trim();
  if (!sid) return;

  const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === sid);
  if (idx < 0) return;

  const row = { ...GL.globalSeats[idx] };
  if (payload.seatSnapshot && typeof payload.seatSnapshot === "object") {
    Object.assign(row, payload.seatSnapshot);
  }

  const before = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  if (mode === "undo") {
    if (!before) return;
    row.person = String(before.person || "").trim() || "비어있음";
    row.personUid = String(before.personUid || "").trim();
    row.personEmail = String(before.personEmail || "").trim();
    row.seatedAt = before.seatedAt ? Number(before.seatedAt) : null;
    row.status = String(before.status || "").trim() || "occupied";
  } else {
    row.person = "비어있음";
    row.personUid = "";
    row.personEmail = "";
    row.seatedAt = null;
    row.status = "empty";
  }

  GL.globalSeats[idx] = row;
}

function syncGlobalWaitingFromPayload(payload = {}, mode = "undo") {
  if (mode === "undo" && Array.isArray(payload.waitingBefore)) {
    replaceGlobalWaitingLocal(JSON.parse(JSON.stringify(payload.waitingBefore)));
    return;
  }
  if (mode !== "redo") return;

  if (payload.kind === "clear_seat") {
    const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
    const prevName = String(seatBefore?.person || "").trim();
    if (!seatBefore || isEmptyPerson(prevName)) return;

    const base = Array.isArray(payload.waitingBefore)
      ? JSON.parse(JSON.stringify(payload.waitingBefore))
      : [...(GL.globalWaiting || [])];
    const bumpJoinedAt = resolveReturnedJoinedAt(payload);
    const nextWaiting = rebuildWaitingAfterSeatToWait(
      base,
      GL.tournamentId,
      {
        uid: String(seatBefore.personUid || "").trim(),
        email: String(seatBefore.personEmail || "").trim(),
        name: prevName
      },
      bumpJoinedAt
    );
    replaceGlobalWaitingLocal(nextWaiting);
    return;
  }

  if (payload.kind !== "assign" || !Array.isArray(payload.waitingBefore)) return;

  const waitingRow = payload.waiting && typeof payload.waiting === "object" ? payload.waiting : null;
  if (!waitingRow) return;

  const waitingTournamentId = String(waitingRow.tournamentId || GL.tournamentId).trim();
  const waitingId = String(waitingRow.id || "").trim();
  const waitingUid = String(waitingRow.uid || "").trim();
  const waitingEmail = String(waitingRow.email || "").trim();
  const waitingName = String(waitingRow.name || "").trim();

  let nextWaiting = payload.waitingBefore.filter((w) => {
    if (!w || typeof w !== "object") return false;
    const wId = String(w.id || "").trim();
    const wUid = String(w.uid || "").trim();
    const wEmail = String(w.email || "").trim();
    const wName = String(w.name || "").trim();
    const wTid = String(w.tournamentId || "").trim();
    const sameTournament = !wTid || wTid === waitingTournamentId;
    if (!sameTournament) return true;
    if (waitingId && wId === waitingId) return false;
    if (waitingUid && wUid && wUid === waitingUid) return false;
    if (waitingEmail && wEmail && wEmail === waitingEmail) return false;
    if (!waitingUid && !waitingEmail && waitingName && wName === waitingName) return false;
    return true;
  });

  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  const prevUid = String(seatBefore?.personUid || "").trim();
  const prevEmail = String(seatBefore?.personEmail || "").trim();
  const prevName = String(seatBefore?.person || "").trim();
  if (seatBefore && !isEmptyPerson(prevName)) {
    const bumpJoinedAt = Number(payload.swapReturnedJoinedAt || 0) || Date.now();
    nextWaiting = rebuildWaitingAfterSeatToWait(
      nextWaiting,
      GL.tournamentId,
      { uid: prevUid, email: prevEmail, name: prevName },
      bumpJoinedAt,
      { source: "seat_swap" }
    );
  }

  replaceGlobalWaitingLocal(nextWaiting);
}

export async function updateGlobalWaiting(nextWaiting = []) {
  await setDoc(
    doc(db, "layout_shared", "global_waiting"),
    {
      version: 2,
      waiting: nextWaiting,
      updatedAt: Date.now(),
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
}

async function undoAssignPayload(payload) {
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const seatRef = resolveUndoSeatRef(payload);
  const now = Date.now();
  const waitingRow = payload.waiting && typeof payload.waiting === "object" ? payload.waiting : null;
  if (!waitingRow) throw new Error("undo_assign_missing_waiting");
  const waitingBefore = Array.isArray(payload.waitingBefore) ? payload.waitingBefore : null;
  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;

  await runTransaction(db, async (tx) => {
    const wSnap = await tx.get(waitingRef);
    const wData = wSnap.exists() ? wSnap.data() || {} : {};
    const arr = Array.isArray(wData.waiting) ? [...wData.waiting] : [];
    const nextWaiting = waitingBefore
      ? JSON.parse(JSON.stringify(waitingBefore))
      : (() => {
          const wid = String(waitingRow.id || "").trim();
          const filtered = wid ? arr.filter((w) => String(w?.id || "").trim() !== wid) : arr;
          filtered.push(waitingRow);
          return filtered;
        })();

    tx.set(
      seatRef,
      appendSeatShellFields(
        seatBefore
          ? {
              person: String(seatBefore.person || "").trim() || "비어있음",
              personUid: String(seatBefore.personUid || "").trim(),
              personEmail: String(seatBefore.personEmail || "").trim(),
              seatedAt: seatBefore.seatedAt ? Number(seatBefore.seatedAt) : null,
              status: String(seatBefore.status || "").trim() || "occupied",
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            }
          : {
              person: "비어있음",
              personUid: "",
              personEmail: "",
              seatedAt: null,
              status: "empty",
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
        payload
      ),
      { merge: true }
    );

    tx.set(
      waitingRef,
      {
        ...wData,
        version: 2,
        waiting: nextWaiting,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    const uid = String(waitingRow.uid || "").trim();
    if (uid) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, uid),
        {
          uid,
          email: String(waitingRow.email || "").trim(),
          name: String(waitingRow.name || "").trim(),
          tournamentId: GL.tournamentId,
          status: "waiting",
          statusChangedAt: resolveWaitingJoinedAt(payload, waitingRow, now),
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }

    const seatUid = String(seatBefore?.personUid || "").trim();
    if (seatUid) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, seatUid),
        {
          uid: seatUid,
          email: String(seatBefore?.personEmail || "").trim(),
          name: String(seatBefore?.person || "").trim(),
          tournamentId: GL.tournamentId,
          status: "assigned",
          statusChangedAt: Number(seatBefore?.seatedAt || 0) || now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(payload.eventId, payload.boxId);
}

async function undoClearSeatPayload(payload) {
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const seatRef = resolveUndoSeatRef(payload);
  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  if (!seatBefore) throw new Error("undo_clear_missing_seat");
  const waitingBefore = Array.isArray(payload.waitingBefore) ? payload.waitingBefore : null;
  const now = Date.now();

  await runTransaction(db, async (tx) => {
    const wSnap = await tx.get(waitingRef);
    const wData = wSnap.exists() ? wSnap.data() || {} : {};
    const nextWaiting = waitingBefore
      ? JSON.parse(JSON.stringify(waitingBefore))
      : Array.isArray(wData.waiting)
        ? [...wData.waiting]
        : [];

    tx.set(
      seatRef,
      appendSeatShellFields(
        {
          person: String(seatBefore.person || "").trim() || "비어있음",
          personUid: String(seatBefore.personUid || "").trim(),
          personEmail: String(seatBefore.personEmail || "").trim(),
          seatedAt: seatBefore.seatedAt ? Number(seatBefore.seatedAt) : null,
          status: String(seatBefore.status || "").trim() || "occupied",
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        payload
      ),
      { merge: true }
    );

    tx.set(
      waitingRef,
      {
        ...wData,
        version: 2,
        waiting: nextWaiting,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    const uid = String(seatBefore.personUid || "").trim();
    if (uid) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, uid),
        {
          uid,
          email: String(seatBefore.personEmail || "").trim(),
          name: String(seatBefore.person || "").trim(),
          tournamentId: GL.tournamentId,
          status: "assigned",
          statusChangedAt: Number(seatBefore.seatedAt || 0) || now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(payload.eventId, payload.boxId);
}

async function redoAssignPayload(payload) {
  const waitingRow = payload.waiting && typeof payload.waiting === "object" ? payload.waiting : null;
  if (!waitingRow) throw new Error("redo_assign_missing_waiting");

  const targetSeatId = String(payload.targetSeatId || "").trim();
  const eventId = String(payload.eventId || "").trim();
  const boxId = String(payload.boxId || "").trim();
  if (!targetSeatId || !eventId || !boxId) throw new Error("redo_assign_bad_ref");

  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const seatRef = resolveUndoSeatRef({
    targetSeatId,
    eventId,
    boxId,
    firestoreDocId: payload.firestoreDocId
  });
  const now = Date.now();
  const seatedAt = resolveAssignedSeatedAt(payload, now);
  const waitingId = String(waitingRow.id || "").trim();
  const waitingUid = String(waitingRow.uid || "").trim();
  const waitingEmail = String(waitingRow.email || "").trim();
  const waitingName = String(waitingRow.name || "").trim();
  const waitingTournamentId = String(waitingRow.tournamentId || GL.tournamentId).trim();

  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const [wSnap, seatSnap] = await Promise.all([tx.get(waitingRef), tx.get(seatRef)]);
    if (!seatSnap?.exists()) throw new Error("seat_not_found");

    const wData = wSnap.exists() ? wSnap.data() || {} : {};
    const arr = Array.isArray(wData.waiting) ? [...wData.waiting] : [];

    let nextWaiting = arr.filter((w) => {
      if (!w || typeof w !== "object") return false;
      const wId = String(w.id || "").trim();
      const wUid = String(w.uid || "").trim();
      const wEmail = String(w.email || "").trim();
      const wName = String(w.name || "").trim();
      const wTid = String(w.tournamentId || "").trim();
      const sameTournament = !wTid || wTid === waitingTournamentId;
      if (!sameTournament) return true;
      if (waitingId && wId === waitingId) return false;
      if (waitingUid && wUid && wUid === waitingUid) return false;
      if (waitingEmail && wEmail && wEmail === waitingEmail) return false;
      if (!waitingUid && !waitingEmail && waitingName && wName === waitingName) return false;
      return true;
    });

    const prevUid = String(seatBefore?.personUid || "").trim();
    const prevEmail = String(seatBefore?.personEmail || "").trim();
    const prevName = String(seatBefore?.person || "").trim();
    if (seatBefore && !isEmptyPerson(prevName)) {
      const bumpJoinedAt = Number(payload.swapReturnedJoinedAt || 0) || now;
      nextWaiting = rebuildWaitingAfterSeatToWait(
        nextWaiting,
        GL.tournamentId,
        { uid: prevUid, email: prevEmail, name: prevName },
        bumpJoinedAt,
        { source: "seat_swap" }
      );
    }

    tx.set(
      seatRef,
      appendSeatShellFields(
        {
          person: String(waitingRow.name || "").trim(),
          personUid: String(waitingRow.uid || "").trim(),
          personEmail: String(waitingRow.email || "").trim(),
          seatedAt,
          status: "occupied",
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        payload
      ),
      { merge: true }
    );

    tx.set(
      waitingRef,
      {
        ...wData,
        version: 2,
        waiting: nextWaiting,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    if (waitingUid) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, waitingUid),
        {
          uid: waitingUid,
          email: String(waitingRow.email || "").trim(),
          name: String(waitingRow.name || "").trim(),
          tournamentId: GL.tournamentId,
          status: "assigned",
          statusChangedAt: seatedAt,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }

    if (prevUid && !isEmptyPerson(prevName)) {
      const bumpJoinedAt = Number(payload.swapReturnedJoinedAt || 0) || now;
      tx.set(
        getAttendanceRef(db, GL.tournamentId, prevUid),
        {
          uid: prevUid,
          email: prevEmail,
          name: prevName,
          tournamentId: GL.tournamentId,
          status: "waiting",
          statusChangedAt: bumpJoinedAt,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(eventId, boxId);
}

async function redoClearSeatPayload(payload) {
  const targetSeatId = String(payload.targetSeatId || "").trim();
  const eventId = String(payload.eventId || "").trim();
  const boxId = String(payload.boxId || "").trim();
  const seatBefore = payload.seatBefore && typeof payload.seatBefore === "object" ? payload.seatBefore : null;
  if (!targetSeatId || !eventId || !boxId || !seatBefore) throw new Error("redo_clear_missing_seat");

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const seatRef = resolveUndoSeatRef({
    targetSeatId,
    eventId,
    boxId,
    firestoreDocId: payload.firestoreDocId
  });
  const now = Date.now();
  const prevUid = String(seatBefore.personUid || "").trim();
  const prevEmail = String(seatBefore.personEmail || "").trim();
  const prevName = String(seatBefore.person || "").trim();

  const otherRefs = getCandidateSeatRefsForPerson(
    db,
    GL.tournamentId,
    GL.globalSeats,
    { uid: prevUid, email: prevEmail, name: prevName },
    targetSeatId
  );

  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const [waitingSnap, seatSnap, ...otherSnaps] = await Promise.all([
      tx.get(waitingRef),
      tx.get(seatRef),
      ...otherRefs.map((r) => tx.get(r))
    ]);
    if (!seatSnap?.exists()) throw new Error("seat_not_found");

    const waitingData = waitingSnap.exists() ? waitingSnap.data() || {} : { waiting: [] };
    const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
    let hasOtherSeat = false;

    if (!isEmptyPerson(prevName)) {
      hasOtherSeat = otherSnaps.some((docSnap) => {
        if (!docSnap.exists()) return false;
        const data = docSnap.data() || {};
        const dSeatId = String(data.seatId || "").trim();
        if (dSeatId === targetSeatId) return false;
        const dUid = String(data.personUid || "").trim();
        const dEmail = String(data.personEmail || "").trim();
        const dName = String(data.person || "").trim();
        const sameUser =
          (prevUid && dUid && prevUid === dUid) ||
          (prevEmail && dEmail && prevEmail === dEmail) ||
          (!prevUid && !prevEmail && prevName && dName === prevName);
        if (!sameUser) return false;
        return !isEmptyPerson(dName);
      });
    }

    tx.set(
      seatRef,
      {
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null,
        status: "empty",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );

    if (!isEmptyPerson(prevName) && !hasOtherSeat) {
      const bumpJoinedAt = resolveReturnedJoinedAt(payload, now);
      const nextWaiting = rebuildWaitingAfterSeatToWait(waitingArr, GL.tournamentId, {
        uid: prevUid,
        email: prevEmail,
        name: prevName
      }, bumpJoinedAt);
      tx.set(
        waitingRef,
        {
          ...waitingData,
          version: 2,
          waiting: nextWaiting,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }

    if (prevUid) {
      tx.set(
        getAttendanceRef(db, GL.tournamentId, prevUid),
        {
          uid: prevUid,
          email: prevEmail,
          name: prevName,
          tournamentId: GL.tournamentId,
          status: hasOtherSeat ? "assigned" : "waiting",
          statusChangedAt: hasOtherSeat ? Number(seatBefore.seatedAt || 0) || now : resolveReturnedJoinedAt(payload, now),
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(eventId, boxId);
}

async function redoAddSeatPayload(payload) {
  const snap =
    payload.seatSnapshot && typeof payload.seatSnapshot === "object" ? payload.seatSnapshot : {};
  const seatId = String(payload.seatId || snap.seatId || "").trim();
  const eventId = String(payload.eventId || snap.currentEventId || snap.mappedEventId || "").trim();
  const boxId = String(payload.boxId || snap.boxId || "").trim();
  if (!seatId || !eventId || !boxId) throw new Error("redo_add_seat_bad_ref");

  const seat = GL.globalSeats.find((s) => String(s?.seatId || "").trim() === seatId);
  const label = String(snap.label || seat?.label || seat?.no || seatId).trim();
  const order = Number(snap.order ?? snap.no ?? seat?.order ?? seat?.no ?? 0) || 0;
  const now = Date.now();

  await setDoc(
    resolveUndoSeatRef({
      seatId,
      targetSeatId: seatId,
      eventId,
      boxId,
      firestoreDocId: payload.firestoreDocId
    }),
    {
      seatId,
      label,
      no: Number(snap.no ?? order) || order,
      order,
      x: Number(snap.x ?? seat?.x ?? 0) || 0,
      y: Number(snap.y ?? seat?.y ?? 0) || 0,
      person: "비어있음",
      personUid: "",
      personEmail: "",
      seatedAt: null,
      status: "empty",
      tournamentId: GL.tournamentId,
      mappedEventId: eventId,
      currentEventId: eventId,
      boxId,
      sourceLayoutDocId: `${eventId}__${boxId}`,
      updatedAt: now,
      updatedAtServer: serverTimestamp()
    },
    { merge: true }
  );
  applySeatSnapshotToGlobalSeats(
    {
      ...snap,
      seatId,
      label,
      no: Number(snap.no ?? order) || order,
      order,
      x: Number(snap.x ?? seat?.x ?? 0) || 0,
      y: Number(snap.y ?? seat?.y ?? 0) || 0,
      person: "비어있음",
      personUid: "",
      personEmail: "",
      seatedAt: null,
      status: "empty",
      tournamentId: GL.tournamentId,
      mappedEventId: eventId,
      currentEventId: eventId,
      boxId,
      sourceLayoutDocId: `${eventId}__${boxId}`
    },
    payload.firestoreDocId
  );
  await syncLayoutProjection(eventId, boxId);
}

async function redoRemoveWaitingPayload(payload) {
  const removed =
    payload.removedWaiting && typeof payload.removedWaiting === "object"
      ? payload.removedWaiting
      : null;
  const wid = String(removed?.id || payload.waitingId || "").trim();
  if (!wid) throw new Error("redo_remove_waiting_bad_ref");

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const now = Date.now();

  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const snap = await tx.get(waitingRef);
    const data = snap.exists() ? snap.data() || {} : {};
    const arr = Array.isArray(data.waiting) ? [...data.waiting] : [];
    const next = arr.filter((w) => String(w?.id || "").trim() !== wid);
    if (next.length === arr.length) throw new Error("redo_remove_waiting_missing_row");
    tx.set(
      waitingRef,
      {
        ...data,
        version: 2,
        waiting: next,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  });
}

function finishUndoRedoUiRefresh(snap = null) {
  resetGlobalLayoutSelectionAfterUndo(snap);
  markGlobalLayoutLocalMutation();
  flushOptimisticGlobalLayoutUi();
  updateGlobalMetaToolbar();
}

export async function undoLastGlobalAction() {
  if (!canManageGlobalLayoutOps()) return;
  const snap = popGlobalUndo();
  if (!snap) return;
  beginUndoRedoMutation();
  try {
    if (snap.kind === "add_seat") {
      const seatRef = resolveUndoSeatRef(snap);
      removeSeatFromGlobalLayoutLocal(snap);
      await deleteDoc(seatRef);
      await syncLayoutProjection(snap.eventId, snap.boxId);
    } else if (snap.kind === "assign") {
      await undoAssignPayload(snap);
      syncGlobalSeatFromAssignPayload(snap, "undo");
      syncGlobalWaitingFromPayload(snap, "undo");
    } else if (snap.kind === "clear_seat") {
      await undoClearSeatPayload(snap);
      syncGlobalSeatFromClearPayload(snap, "undo");
      syncGlobalWaitingFromPayload(snap, "undo");
    } else if (snap.kind === "delete_seat") {
      const d = snap.seatDoc && typeof snap.seatDoc === "object" ? snap.seatDoc : {};
      const sid = String(snap.seatId || d.seatId || "").trim();
      const eid = String(snap.eventId || d.currentEventId || d.mappedEventId || "").trim();
      const bid = String(snap.boxId || d.boxId || "").trim();
      if (!sid || !eid || !bid) throw new Error("undo_delete_bad_ref");
      const seatRef = resolveUndoSeatRef({
        seatId: sid,
        targetSeatId: sid,
        eventId: eid,
        boxId: bid,
        firestoreDocId: snap.firestoreDocId
      });
      await setDoc(seatRef, d, { merge: true });
      applySeatSnapshotToGlobalSeats(
        {
          ...d,
          seatId: sid,
          label: String(d.label ?? d.no ?? sid).trim(),
          order: Number(d.order ?? d.no ?? 0) || 0
        },
        snap.firestoreDocId
      );
      await syncLayoutProjection(eid, bid);
    } else if (snap.kind === "remove_waiting") {
      const restored = Array.isArray(snap.snapshotBefore) ? snap.snapshotBefore : [];
      await updateGlobalWaiting(restored);
      replaceGlobalWaitingLocal(JSON.parse(JSON.stringify(restored)));
    } else {
      throw new Error("undo_unknown_kind");
    }
    pushGlobalRedo(snap);
  } catch (err) {
    console.error("undoLastGlobalAction error:", err);
    restoreGlobalUndo(snap);
    alert("되돌리기에 실패했습니다.");
    updateGlobalMetaToolbar();
    return;
  } finally {
    endUndoRedoMutation();
  }

  finishUndoRedoUiRefresh(snap);
}

export async function redoLastGlobalAction() {
  if (!canManageGlobalLayoutOps()) return;
  const snap = popGlobalRedo();
  if (!snap) return;
  beginUndoRedoMutation();
  try {
    if (snap.kind === "add_seat") {
      await redoAddSeatPayload(snap);
    } else if (snap.kind === "assign") {
      await redoAssignPayload(snap);
      syncGlobalSeatFromAssignPayload(snap, "redo");
      syncGlobalWaitingFromPayload(snap, "redo");
    } else if (snap.kind === "clear_seat") {
      await redoClearSeatPayload(snap);
      syncGlobalSeatFromClearPayload(snap, "redo");
      syncGlobalWaitingFromPayload(snap, "redo");
    } else if (snap.kind === "delete_seat") {
      const d = snap.seatDoc && typeof snap.seatDoc === "object" ? snap.seatDoc : {};
      const sid = String(snap.seatId || d.seatId || "").trim();
      const eid = String(snap.eventId || d.currentEventId || d.mappedEventId || "").trim();
      const bid = String(snap.boxId || d.boxId || "").trim();
      if (!sid || !eid || !bid) throw new Error("redo_delete_bad_ref");
      const seatRef = resolveUndoSeatRef({
        seatId: sid,
        targetSeatId: sid,
        eventId: eid,
        boxId: bid,
        firestoreDocId: snap.firestoreDocId
      });
      await deleteDoc(seatRef);
      await syncLayoutProjection(eid, bid);
    } else if (snap.kind === "remove_waiting") {
      await redoRemoveWaitingPayload(snap);
    } else {
      throw new Error("redo_unknown_kind");
    }
    pushGlobalUndo(snap, { clearRedo: false });
  } catch (err) {
    console.error("redoLastGlobalAction error:", err);
    restoreGlobalRedo(snap);
    alert("앞으로 돌리기에 실패했습니다.");
    updateGlobalMetaToolbar();
    return;
  } finally {
    endUndoRedoMutation();
  }

  finishUndoRedoUiRefresh(snap);
}

export async function addManualWaitingByName(rawName = "") {
  const name = String(rawName || "").trim();
  if (!name) {
    alert("대기자 이름을 입력하세요.");
    return;
  }
  const input = document.getElementById("manualWaitingNameInput");
  if (input) input.value = name;
  await addManualWaiting();
}

export async function addManualWaiting() {
  const input = document.getElementById("manualWaitingNameInput");
  const name = String(input?.value || "").trim();
  if (!name) {
    alert("대기자 이름을 입력하세요.");
    return;
  }

  const now = Date.now();
  const row = {
    id: makeUid("wait"),
    uid: "",
    email: "",
    name,
    tournamentId: GL.tournamentId,
    joinedAt: now
  };
  const snapshotBefore = JSON.parse(JSON.stringify(GL.globalWaiting || []));
  replaceGlobalWaitingLocal([...(GL.globalWaiting || []), row]);
  flushOptimisticGlobalLayoutUi();
  if (input) input.value = "";

  GL.waitingMutationInFlight = true;
  markGlobalLayoutLocalMutation();
  try {
    await updateGlobalWaiting([...(GL.globalWaiting || [])]);
  } catch (err) {
    console.error("addManualWaiting error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("대기 추가에 실패했습니다.");
  } finally {
    GL.waitingMutationInFlight = false;
  }
}

export async function removeManualWaiting(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  const snapshotBefore = JSON.parse(JSON.stringify(GL.globalWaiting || []));
  const row = snapshotBefore.find((w) => String(w?.id || "").trim() === wid);
  if (!row) return;

  const next = snapshotBefore.filter((w) => String(w?.id || "").trim() !== wid);
  GL.waitingMutationInFlight = true;
  markGlobalLayoutLocalMutation();
  replaceGlobalWaitingLocal(next);
  flushOptimisticGlobalLayoutUi();

  if (GL.selectedWaitingId === wid) {
    GL.selectedWaitingId = "";
    void clearMyWaitingPick();
  }

  try {
    await updateGlobalWaiting([...(GL.globalWaiting || [])]);
    pushGlobalUndo({
      kind: "remove_waiting",
      snapshotBefore,
      removedWaiting: { ...row }
    });
  } catch (err) {
    console.error("removeManualWaiting error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("대기자 삭제에 실패했습니다.");
  } finally {
    GL.waitingMutationInFlight = false;
  }
}

export async function setWaitingBlocked(waitingId = "", checked = false) {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  let target = resolveWaitingEntryById(wid);
  if (!target) {
    applyWaitingBlockLocal(wid, checked === true);
    target = resolveWaitingEntryById(wid);
  }
  if (!target) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const now = Date.now();
  const nextChecked = checked === true;
  const snapshotBefore = JSON.parse(JSON.stringify(GL.globalWaiting || []));

  applyWaitingBlockLocal(wid, nextChecked);
  invalidateWaitingPanelFingerprint();
  flushOptimisticGlobalLayoutUi();

  GL.waitingMutationInFlight = true;
  markGlobalLayoutLocalMutation();
  let blockSaved = false;
  try {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(waitingRef);
    const data = snap.exists() ? (snap.data() || {}) : {};
    const arr = Array.isArray(data.waiting) ? [...data.waiting] : [];

    const targetUid = String(target.uid || "").trim();
    const targetEmail = String(target.email || "").trim().toLowerCase();
    const targetName = String(target.name || "").trim();
    const targetTid = String(target.tournamentId || GL.tournamentId || "").trim();

    let idx = arr.findIndex((w) => String(w?.id || "").trim() === wid);
    if (idx < 0) {
      idx = arr.findIndex((w) => {
        const wTid = String(w?.tournamentId || "").trim();
        if (targetTid && wTid && targetTid !== wTid) return false;
        const wUid = String(w?.uid || "").trim();
        const wEmail = String(w?.email || "").trim().toLowerCase();
        const wName = String(w?.name || "").trim();
        if (targetUid && wUid && targetUid === wUid) return true;
        if (!targetUid && targetEmail && wEmail && targetEmail === wEmail) return true;
        if (!targetUid && !targetEmail && targetName && wName === targetName) return true;
        return false;
      });
    }

    const base = idx >= 0 && arr[idx] && typeof arr[idx] === "object"
      ? { ...arr[idx] }
      : {
          id: wid,
          uid: String(target.uid || "").trim(),
          email: String(target.email || "").trim(),
          name: String(target.name || "").trim(),
          tournamentId: String(target.tournamentId || GL.tournamentId || "").trim(),
          joinedAt: Number(target.joinedAt || target.createdAt || Date.now()) || Date.now()
        };

    const prevChecked = base.blockChecked === true;
    if (prevChecked === nextChecked) return;

    if (nextChecked) {
      base.blockChecked = true;
      base.blockCheckedAt = now;
    } else {
      const startedAt = Number(base.blockCheckedAt || 0);
      const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
      base.blockChecked = false;
      base.blockCheckedAt = null;
      base.blockAccumulatedMs = Number(base.blockAccumulatedMs || 0) + elapsed;
    }

    if (idx >= 0) arr[idx] = base;
    else arr.push(base);

    tx.set(
      waitingRef,
      {
        ...data,
        version: 2,
        waiting: arr,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  });
  blockSaved = true;
  } catch (err) {
    console.error("setWaitingBlocked error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("BLOCK 변경에 실패했습니다.");
  } finally {
    GL.waitingMutationInFlight = false;
    if (blockSaved) {
      applyWaitingBlockLocal(wid, nextChecked);
      invalidateWaitingPanelFingerprint();
      flushOptimisticGlobalLayoutUi();
    }
  }
}
