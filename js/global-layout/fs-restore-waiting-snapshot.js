import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import {
  isPersonSeatedInGlobalSeats,
  personExistsInGlobalWaiting
} from "../shared/tournament-waiting-queue.js";
import { GL } from "./state.js";
import { getAttendanceRef } from "./utils.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
import { replaceGlobalWaitingLocal } from "./waiting.js";
import { bumpGlobalLayoutDataRevision, scheduleGlobalLayoutRealtimeUi } from "./realtime-ui.js";

/** 운영 스냅샷 — 대기열이 잘못 정리됐을 때 복구용 (대회별) */
const WAITING_SNAPSHOT_BY_TOURNAMENT = {
  "APL JEJU": [
    "지렁이",
    "김태중",
    "sia",
    "명환",
    "SIRI",
    "김진현",
    "황인엽",
    "김해진",
    "작준.",
    "SKY",
    "오시우",
    "윤인규"
  ]
};

function normalizeWaitingNameKey(name = "") {
  return String(name || "").trim().toLowerCase();
}

async function loadUsersByNickname() {
  const byKey = new Map();
  const snap = await getDocs(collection(db, "users"));
  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const nick = String(data.nickname || data.name || "").trim();
    if (!nick) return;
    const row = {
      uid: docSnap.id,
      email: String(data.email || "").trim(),
      name: nick
    };
    byKey.set(normalizeWaitingNameKey(nick), row);
  });
  return byKey;
}

function buildSnapshotRestoreCandidates(names = [], usersByNick, globalWaiting, globalSeats, tournamentId) {
  const missing = [];
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const user = usersByNick.get(normalizeWaitingNameKey(name)) || null;
    const person = {
      uid: String(user?.uid || "").trim(),
      email: String(user?.email || "").trim(),
      name: user?.name || name
    };
    if (
      isPersonSeatedInGlobalSeats(globalSeats, {
        uid: person.uid,
        email: person.email,
        name: person.name
      })
    ) {
      continue;
    }
    if (personExistsInGlobalWaiting(globalWaiting, tournamentId, person)) continue;
    missing.push({
      ...person,
      joinedAt: Date.now()
    });
  }
  return missing;
}

/**
 * 스냅샷 이름 기준 global_waiting·출석 복구 (이미 있으면 스킵)
 */
export async function restoreWaitingSnapshotForCurrentTournament() {
  const tid = String(GL.tournamentId || "").trim();
  const names = WAITING_SNAPSHOT_BY_TOURNAMENT[tid];
  if (!tid || !names?.length) return 0;

  const usersByNick = await loadUsersByNickname();
  const missing = buildSnapshotRestoreCandidates(
    names,
    usersByNick,
    GL.globalWaiting,
    GL.globalSeats,
    tid
  );
  if (!missing.length) return 0;

  const waitingRef = doc(db, "layout_shared", "global_waiting");
  let healed = null;
  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const waitingSnap = await tx.get(waitingRef);
    const waitingData = waitingSnap.exists()
      ? waitingSnap.data() || {}
      : { version: 2, waiting: [], updatedAt: Date.now() };
    let waitingArr = Array.isArray(waitingData.waiting) ? [...waitingData.waiting] : [];
    const now = Date.now();
    let changed = false;

    for (const person of missing) {
      if (personExistsInGlobalWaiting(waitingArr, tid, person)) continue;
      const joinMs = Number(person.joinedAt || 0) || now;
      waitingArr = rebuildWaitingAfterSeatToWait(waitingArr, tid, person, joinMs, {
        source: "waiting_snapshot_restore",
        ...(person.uid ? { id: `w_${person.uid}` } : {})
      });
      changed = true;

      if (!person.uid) continue;
      tx.set(
        getAttendanceRef(db, tid, person.uid),
        {
          uid: person.uid,
          email: person.email,
          name: person.name,
          nickname: person.name,
          tournamentId: tid,
          status: "waiting",
          statusChangedAt: joinMs,
          checkedInAt: joinMs,
          checkedOutAt: null,
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: "",
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    }

    if (!changed) return;
    healed = waitingArr;
    tx.set(
      waitingRef,
      {
        ...waitingData,
        version: 2,
        waiting: waitingArr,
        updatedAt: now,
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  });

  if (!healed) return 0;
  console.info("[restoreWaitingSnapshot] restored", missing.length, "row(s) for", tid);
  replaceGlobalWaitingLocal(healed);
  bumpGlobalLayoutDataRevision();
  scheduleGlobalLayoutRealtimeUi({ waiting: true });
  return missing.length;
}
