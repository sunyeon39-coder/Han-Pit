import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "../shared/firestore-quota-guard.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import {
  applyIndexGlobalSeatsSnapshot,
  applyIndexOpsSeatsFromGlRows
} from "./dealer-attendance-realtime.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import {
  readGlobalSeatsCache,
  readGlobalSeatsLegacyCache,
  readIndexGlobalWaitingCache,
  writeIndexGlobalWaitingCache,
  writeGlobalSeatsCache
} from "./index-ops-session-cache.js";

function globalSeatsRowsFromSnapshot(snap) {
  const rows = [];
  for (const d of snap?.docs || []) {
    const data = d.data() || {};
    rows.push({
      seatId: String(data.seatId || d.id || "").trim(),
      person: String(data.person || "").trim(),
      personUid: String(data.personUid || "").trim(),
      personEmail: String(data.personEmail || "").trim(),
      currentEventId: String(data.currentEventId || data.mappedEventId || "").trim(),
      boxId: String(data.boxId || "").trim(),
      label: String(data.label || data.no || "").trim(),
      seatedAt: Number(data.seatedAt || 0) || 0
    });
  }
  return rows;
}

/** 인증·realtime 이전 — 마지막으로 본 대기·좌석을 즉시 표시 */
export function seedIndexOpsFromSessionCache() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;

  let seeded = false;

  const waiting = readIndexGlobalWaitingCache(tournamentId);
  if (waiting?.length) {
    IX.globalWaiting = waiting;
    seeded = true;
  }

  const seats = readGlobalSeatsCache(tournamentId) || readGlobalSeatsLegacyCache(tournamentId);
  if (seats?.length) {
    applyIndexOpsSeatsFromGlRows(seats, { scheduleRender: false });
    seeded = true;
  }

  if (seeded) scheduleRenderDealerOps();
  return seeded;
}

/** IndexedDB 캐시가 비었을 때 서버에서 대기·좌석을 한 번 더 읽습니다. */
export async function refreshIndexOpsDataFromServer() {
  const tournamentId = getTournamentId();
  if (!tournamentId || isFirestoreQuotaCoolingDown()) return;

  try {
    const snap = await getDocFromServer(doc(db, "layout_shared", "global_waiting"));
    const data = snap.exists() ? snap.data() || {} : {};
    const nextWaiting = Array.isArray(data.waiting) ? data.waiting : [];
    IX.globalWaiting = nextWaiting;
    writeIndexGlobalWaitingCache(tournamentId, nextWaiting);
    scheduleRenderDealerOps();
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshIndexOpsDataFromServer waiting:", err?.code || err);
  }

  try {
    const snap = await getDocsFromServer(
      collection(db, "tournaments", tournamentId, "global_seats")
    );
    applyIndexGlobalSeatsSnapshot(snap);
    writeGlobalSeatsCache(tournamentId, globalSeatsRowsFromSnapshot(snap));
  } catch (err) {
    noteFirestoreQuotaExceeded(err);
    console.warn("refreshIndexOpsDataFromServer seats:", err?.code || err);
  }
}
