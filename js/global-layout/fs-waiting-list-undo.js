import { db } from "../firebase.js";
import {
  deleteDoc,
  doc,
  runTransaction,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { GL } from "./state.js";
import { buildGlobalSeatDocId, getAttendanceRef, makeUid } from "./utils.js";
import {
  applyWaitingBlockLocal,
  getCurrentTournamentWaiting,
  replaceGlobalWaitingLocal
} from "./waiting.js";
import { flushOptimisticGlobalLayoutUi } from "./optimistic-seat-mutation.js";
import { renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { clearMyWaitingPick } from "./waiting-picks.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { syncLayoutProjection } from "./fs-layout-projection.js";
import { popGlobalUndo, restoreGlobalUndo, pushGlobalUndo } from "./undo-stack.js";

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
  const seatRef = doc(
    db,
    "tournaments",
    GL.tournamentId,
    "global_seats",
    buildGlobalSeatDocId(payload.eventId, payload.boxId, payload.targetSeatId)
  );
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
          statusChangedAt: now,
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
          statusChangedAt: now,
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
  const seatRef = doc(
    db,
    "tournaments",
    GL.tournamentId,
    "global_seats",
    buildGlobalSeatDocId(payload.eventId, payload.boxId, payload.targetSeatId)
  );
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
      {
        person: String(seatBefore.person || "").trim() || "비어있음",
        personUid: String(seatBefore.personUid || "").trim(),
        personEmail: String(seatBefore.personEmail || "").trim(),
        seatedAt: seatBefore.seatedAt ? Number(seatBefore.seatedAt) : null,
        status: String(seatBefore.status || "").trim() || "occupied",
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
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
          statusChangedAt: now,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  await syncLayoutProjection(payload.eventId, payload.boxId);
}

export async function undoLastGlobalAction() {
  if (!GL.isAdminUser) return;
  const snap = popGlobalUndo();
  if (!snap) return;
  try {
    if (snap.kind === "add_seat") {
      await deleteDoc(
        doc(
          db,
          "tournaments",
          GL.tournamentId,
          "global_seats",
          buildGlobalSeatDocId(snap.eventId, snap.boxId, snap.seatId)
        )
      );
      await syncLayoutProjection(snap.eventId, snap.boxId);
    } else if (snap.kind === "assign") {
      await undoAssignPayload(snap);
    } else if (snap.kind === "clear_seat") {
      await undoClearSeatPayload(snap);
    } else if (snap.kind === "delete_seat") {
      const d = snap.seatDoc && typeof snap.seatDoc === "object" ? snap.seatDoc : {};
      const sid = String(snap.seatId || d.seatId || "").trim();
      const eid = String(snap.eventId || d.currentEventId || d.mappedEventId || "").trim();
      const bid = String(snap.boxId || d.boxId || "").trim();
      if (!sid || !eid || !bid) throw new Error("undo_delete_bad_ref");
      await setDoc(
        doc(db, "tournaments", GL.tournamentId, "global_seats", buildGlobalSeatDocId(eid, bid, sid)),
        d,
        { merge: true }
      );
      await syncLayoutProjection(eid, bid);
    } else if (snap.kind === "remove_waiting") {
      await updateGlobalWaiting(Array.isArray(snap.snapshotBefore) ? snap.snapshotBefore : []);
    } else {
      throw new Error("undo_unknown_kind");
    }
  } catch (err) {
    console.error("undoLastGlobalAction error:", err);
    restoreGlobalUndo(snap);
    alert("되돌리기에 실패했습니다.");
    updateGlobalMetaToolbar();
    return;
  }

  if (GL.activeTab === "seat") renderSeatPanel();
  else renderWaiting(getCurrentTournamentWaiting());
  updateGlobalMetaToolbar();
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

  try {
    await updateGlobalWaiting([...(GL.globalWaiting || [])]);
  } catch (err) {
    console.error("addManualWaiting error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("대기 추가에 실패했습니다.");
  }
}

export async function removeManualWaiting(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  const snapshotBefore = JSON.parse(JSON.stringify(GL.globalWaiting || []));
  const next = snapshotBefore.filter((w) => String(w?.id || "").trim() !== wid);
  replaceGlobalWaitingLocal(next);
  flushOptimisticGlobalLayoutUi();
  pushGlobalUndo({ kind: "remove_waiting", snapshotBefore: JSON.parse(JSON.stringify(getCurrentTournamentWaiting())) });
  if (GL.selectedWaitingId === wid) {
    GL.selectedWaitingId = "";
    void clearMyWaitingPick();
  }

  try {
    await updateGlobalWaiting([...(GL.globalWaiting || [])]);
  } catch (err) {
    console.error("removeManualWaiting error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("대기자 삭제에 실패했습니다.");
  }
}

export async function setWaitingBlocked(waitingId = "", checked = false) {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  const target = getCurrentTournamentWaiting().find((w) => String(w?.id || "").trim() === wid);
  if (!target) return;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const now = Date.now();
  const nextChecked = checked === true;
  const snapshotBefore = JSON.parse(JSON.stringify(GL.globalWaiting || []));

  applyWaitingBlockLocal(wid, nextChecked);
  flushOptimisticGlobalLayoutUi();

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
  } catch (err) {
    console.error("setWaitingBlocked error:", err);
    replaceGlobalWaitingLocal(snapshotBefore);
    flushOptimisticGlobalLayoutUi();
    alert("BLOCK 변경에 실패했습니다.");
  }
}
