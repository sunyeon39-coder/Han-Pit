import { db } from "../firebase.js";
import {
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { runFirestoreTransactionWithRetry } from "./firestore-transaction-retry.js";
import { globalWaitingCollectionRef, globalWaitingDocRef } from "./tournament-waiting-queue.js";
import { diffGlobalWaitingRows } from "../global-layout/waiting-entry-refs.js";
import { runSerializedGlobalWaitingWrite } from "../global-layout/global-waiting-write-lock.js";

function waitingRowMatchesCheckIn(item = {}, uid = "", tournamentId = "") {
  if (!item || typeof item !== "object") return false;
  const itemUid = String(item.uid || "").trim();
  const itemTournamentId = String(item.tournamentId || "").trim();
  const tid = String(tournamentId || "").trim();
  if (itemUid !== String(uid || "").trim()) return false;
  if (!itemTournamentId) return true;
  return itemTournamentId === tid;
}

export function buildCheckInWaitingRow({
  uid = "",
  email = "",
  nickname = "",
  tournamentId = "",
  nowMs = Date.now(),
  existing = null
} = {}) {
  const safeUid = String(uid || "").trim();
  const now = Number(nowMs) || Date.now();
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const row = {
    ...base,
    id: String(base.id || `w_${safeUid}`).trim() || `w_${safeUid}`,
    uid: safeUid,
    email: String(email || "").trim(),
    name: String(nickname || "").trim() || safeUid,
    addedAt: now,
    joinedAt: now,
    createdAt: now,
    source: "checkin",
    tournamentId: String(tournamentId || "").trim()
  };
  if (existing?.blockChecked !== true) {
    row.blockChecked = false;
    row.blockCheckedAt = null;
    row.blockAccumulatedMs = Number(existing?.blockAccumulatedMs || 0) || 0;
  }
  delete row.joinedAtServer;
  delete row.carryStartedAt;
  return row;
}

/** Firestore global_waiting 에 출근 대기 행을 트랜잭션으로 추가·갱신 */
export async function upsertCheckInIntoGlobalWaiting({
  uid = "",
  email = "",
  nickname = "",
  tournamentId = ""
} = {}) {
  const safeUid = String(uid || "").trim();
  const tid = String(tournamentId || "").trim();
  if (!safeUid || !tid) return { ok: false, row: null };

  const collRef = globalWaitingCollectionRef(db, tid);
  const now = Date.now();
  let savedRow = null;

  const existingSnap = await getDocs(query(collRef, where("uid", "==", safeUid)));
  const candidateRefs = existingSnap.docs.map((d) => d.ref);
  const canonicalRef = globalWaitingDocRef(db, tid, `w_${safeUid}`);
  if (!candidateRefs.some((r) => r.path === canonicalRef.path)) candidateRefs.push(canonicalRef);

  await runSerializedGlobalWaitingWrite(() => runFirestoreTransactionWithRetry(db, async (tx) => {
    const snaps = await Promise.all(candidateRefs.map((r) => tx.get(r)));
    const prevRows = snaps
      .map((s, i) => (s.exists() ? { id: candidateRefs[i].id, ...s.data() } : null))
      .filter(Boolean);

    const existing = prevRows.find((row) => waitingRowMatchesCheckIn(row, safeUid, tid)) || null;
    savedRow = buildCheckInWaitingRow({
      uid: safeUid,
      email,
      nickname,
      tournamentId: tid,
      nowMs: now,
      existing
    });

    const { toSet, toDelete } = diffGlobalWaitingRows(prevRows, [savedRow]);
    for (const { id, data } of toSet) {
      tx.set(globalWaitingDocRef(db, tid, id), data, { merge: true });
    }
    for (const id of toDelete) {
      tx.delete(globalWaitingDocRef(db, tid, id));
    }
  }));

  return { ok: true, row: savedRow };
}

/** index·통합배치도 로컬 캐시에 출근 행을 즉시 반영 */
export function mergeCheckInRowIntoLocalWaiting(list = [], row = null, tournamentId = "") {
  if (!row || typeof row !== "object") return Array.isArray(list) ? [...list] : [];
  const tid = String(tournamentId || row.tournamentId || "").trim();
  const uid = String(row.uid || "").trim();
  const next = Array.isArray(list) ? [...list] : [];
  const idx = next.findIndex((item) => waitingRowMatchesCheckIn(item, uid, tid));
  if (idx >= 0) next[idx] = { ...next[idx], ...row };
  else next.push({ ...row });
  return next;
}
