import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/** 대회당 최신 N건만 유지 (Cloud Function 과 동일) */
export const ATTENDANCE_LOG_MAX_PER_TOURNAMENT = 30000;
/** N일 지난 로그 삭제 */
export const ATTENDANCE_LOG_RETENTION_DAYS = 45;
const PRUNE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PRUNE_BATCH = 80;

function pruneSessionKey(tournamentId = "") {
  return `hanPitAttendanceLogPruneAt:${String(tournamentId || "").trim()}`;
}

function readLastPruneAt(tournamentId = "") {
  try {
    return Number(sessionStorage.getItem(pruneSessionKey(tournamentId)) || 0);
  } catch {
    return 0;
  }
}

function markPruneAttempt(tournamentId = "") {
  try {
    sessionStorage.setItem(pruneSessionKey(tournamentId), String(Date.now()));
  } catch {
    /* ignore */
  }
}

/**
 * admin·운영 권한 — 오래된/초과 출근 로그를 백그라운드에서 정리 (6h 쿨다운)
 * Firestore delete 는 rules 상 isAdmin() 만 허용.
 */
export async function maybePruneAttendanceLogsForTournament(tournamentId = "", options = {}) {
  const tid = String(tournamentId || "").trim();
  if (!tid || options.isAdmin !== true) return { deleted: 0, skipped: true };

  const last = readLastPruneAt(tid);
  if (last && Date.now() - last < PRUNE_COOLDOWN_MS) {
    return { deleted: 0, skipped: true };
  }
  markPruneAttempt(tid);

  const col = collection(db, "dealer_attendance_logs");
  const cutoff = Date.now() - ATTENDANCE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    const oldSnap = await getDocs(
      query(col, where("tournamentId", "==", tid), where("createdAt", "<", cutoff), limit(PRUNE_BATCH))
    );
    if (oldSnap.docs.length) {
      // 최대 80건을 한 건씩 지우는 대신 배치 하나로 묶어 왕복 횟수를 줄인다.
      const batch = writeBatch(db);
      for (const d of oldSnap.docs) batch.delete(d.ref);
      await batch.commit();
      deleted += oldSnap.docs.length;
    }

    const recentSnap = await getDocs(
      query(
        col,
        where("tournamentId", "==", tid),
        orderBy("createdAt", "desc"),
        limit(ATTENDANCE_LOG_MAX_PER_TOURNAMENT + 1)
      )
    );
    if (recentSnap.size > ATTENDANCE_LOG_MAX_PER_TOURNAMENT) {
      const threshold = Number(recentSnap.docs[recentSnap.docs.length - 1].data()?.createdAt || 0);
      if (threshold > 0) {
        const excessSnap = await getDocs(
          query(
            col,
            where("tournamentId", "==", tid),
            where("createdAt", "<=", threshold),
            limit(PRUNE_BATCH)
          )
        );
        if (excessSnap.docs.length) {
          const batch = writeBatch(db);
          for (const d of excessSnap.docs) batch.delete(d.ref);
          await batch.commit();
          deleted += excessSnap.docs.length;
        }
      }
    }
  } catch (err) {
    console.warn("maybePruneAttendanceLogsForTournament:", err?.code || err);
  }

  return { deleted, skipped: false };
}
