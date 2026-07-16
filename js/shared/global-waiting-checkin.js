import { db } from "../firebase.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { runFirestoreTransactionWithRetry } from "./firestore-transaction-retry.js";

const GLOBAL_WAITING_REF = () => doc(db, "layout_shared", "global_waiting");

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

  const waitingRef = GLOBAL_WAITING_REF();
  const now = Date.now();
  let savedRow = null;

  await runFirestoreTransactionWithRetry(db, async (tx) => {
    const waitingSnap = await tx.get(waitingRef);
    const waitingState = waitingSnap.exists()
      ? waitingSnap.data() || {}
      : { version: 2, waiting: [], updatedAt: now };
    const waitingList = Array.isArray(waitingState.waiting) ? [...waitingState.waiting] : [];

    const existingIdx = waitingList.findIndex((item) =>
      waitingRowMatchesCheckIn(item, safeUid, tid)
    );
    const existing = existingIdx >= 0 ? waitingList[existingIdx] : null;
    savedRow = buildCheckInWaitingRow({
      uid: safeUid,
      email,
      nickname,
      tournamentId: tid,
      nowMs: now,
      existing
    });

    if (existingIdx >= 0) waitingList[existingIdx] = savedRow;
    else waitingList.push(savedRow);

    tx.set(
      waitingRef,
      {
        ...waitingState,
        version: 2,
        waiting: waitingList,
        updatedAt: now
      },
      { merge: true }
    );
  });

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
