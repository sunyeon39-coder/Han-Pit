import { db } from "../firebase.js";
import {
  deleteDoc,
  doc,
  runTransaction,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";
import { buildGlobalSeatDocId, getAttendanceRef, makeUid } from "./utils.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { renderSeatPanel, renderWaiting } from "./panel-ui.js";
import { updateGlobalMetaToolbar } from "./toolbar.js";
import { syncLayoutProjection } from "./fs-layout-projection.js";

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

  await runTransaction(db, async (tx) => {
    const wSnap = await tx.get(waitingRef);
    const wData = wSnap.exists() ? wSnap.data() || {} : {};
    const arr = Array.isArray(wData.waiting) ? [...wData.waiting] : [];
    const wid = String(waitingRow.id || "").trim();
    const filtered = wid ? arr.filter((w) => String(w?.id || "").trim() !== wid) : arr;
    filtered.push(waitingRow);

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

    tx.set(
      waitingRef,
      {
        ...wData,
        version: 2,
        waiting: filtered,
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
  });

  await syncLayoutProjection(payload.eventId, payload.boxId);
}

export async function undoLastGlobalAction() {
  if (!GL.isAdminUser || !GL.lastGlobalUndo) return;
  const snap = GL.lastGlobalUndo;
  GL.lastGlobalUndo = null;
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
    GL.lastGlobalUndo = snap;
    alert("되돌리기에 실패했습니다.");
    updateGlobalMetaToolbar();
    return;
  }

  if (GL.activeTab === "seat") renderSeatPanel();
  else renderWaiting(getCurrentTournamentWaiting());
}

export async function addManualWaiting() {
  const input = document.getElementById("manualWaitingNameInput");
  const name = String(input?.value || "").trim();
  if (!name) {
    alert("대기자 이름을 입력하세요.");
    return;
  }

  const current = getCurrentTournamentWaiting();
  const now = Date.now();
  const next = [
    ...current,
    {
      id: makeUid("wait"),
      uid: "",
      email: "",
      name,
      tournamentId: GL.tournamentId,
      joinedAt: now
    }
  ];
  await updateGlobalWaiting(next);
  if (input) input.value = "";
}

export async function removeManualWaiting(waitingId = "") {
  const wid = String(waitingId || "").trim();
  if (!wid) return;
  const snapshotBefore = JSON.parse(JSON.stringify(getCurrentTournamentWaiting()));
  const next = snapshotBefore.filter((w) => String(w?.id || "") !== wid);
  await updateGlobalWaiting(next);
  GL.lastGlobalUndo = { kind: "remove_waiting", snapshotBefore };
  if (GL.selectedWaitingId === wid) GL.selectedWaitingId = "";
}
