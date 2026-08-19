import { db } from "../firebase.js";
import {
  collection,
  getDocs,
  getDocsFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { globalWaitingCollectionRef } from "../shared/tournament-waiting-queue.js";

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
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
import { loadTournamentDealerRosterOnce } from "./dealer-attendance-roster.js";
import {
  readGlobalSeatsCache,
  readGlobalSeatsLegacyCache,
  readIndexGlobalWaitingCache,
  writeIndexGlobalWaitingCache,
  writeGlobalSeatsCache
} from "./index-ops-session-cache.js";
import { readHubTournamentsPersistedCache } from "../hub/hub-tournaments-session-cache.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";

let bootstrapInflight = null;
let bootstrapSeq = 0;

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

/** 허브·sessionStorage — 대회 문서 도착 전 requiredCode 로 명단 조회 가능하게 */
export function seedIndexTournamentMetaFromHubCache() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return false;

  const cachedCode = String(
    sessionStorage.getItem(`tournamentRequiredCode:${tournamentId}`) || ""
  ).trim();
  if (cachedCode && !String(IX.currentTournament?.requiredCode || "").trim()) {
    IX.currentTournament = {
      ...(IX.currentTournament || {}),
      id: tournamentId,
      requiredCode: cachedCode
    };
  }

  const list = readHubTournamentsPersistedCache();
  const row = Array.isArray(list)
    ? list.find((t) => String(t?.id || "").trim() === tournamentId)
    : null;
  if (!row) return Boolean(cachedCode);

  const requiredCode = String(row.requiredCode || cachedCode || "").trim();
  IX.currentTournament = {
    ...(IX.currentTournament || {}),
    id: tournamentId,
    name: String(row.name || IX.currentTournament?.name || tournamentId).trim(),
    logoText: String(row.logoText || IX.currentTournament?.logoText || "").trim(),
    requiredCode,
    startDate: row.startDate || IX.currentTournament?.startDate || "",
    endDate: row.endDate || IX.currentTournament?.endDate || ""
  };
  if (requiredCode) {
    sessionStorage.setItem(`tournamentRequiredCode:${tournamentId}`, requiredCode);
  }
  return true;
}

export async function prefetchIndexOpsFromFirestoreCache() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return;

  try {
    const snap = await getDocs(globalWaitingCollectionRef(db, tournamentId));
    if (snap.empty) return;
    const nextWaiting = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!nextWaiting.length && IX.globalWaiting.length) return;
    IX.globalWaiting = nextWaiting;
    writeIndexGlobalWaitingCache(tournamentId, nextWaiting);
    scheduleRenderDealerOps();
  } catch (err) {
    console.warn("prefetchIndexOps waiting:", err?.code || err);
  }

  try {
    const snap = await getDocs(collection(db, "tournaments", tournamentId, "global_seats"));
    if (snap.empty && IX.dealerGlobalSeats.length) return;
    if (!snap.empty) {
      applyIndexGlobalSeatsSnapshot(snap);
      if (!snap.metadata?.fromCache) {
        writeGlobalSeatsCache(tournamentId, globalSeatsRowsFromSnapshot(snap));
      }
    }
  } catch (err) {
    console.warn("prefetchIndexOps seats:", err?.code || err);
  }
}

/** IndexedDB 캐시가 비었을 때 서버에서 대기·좌석을 한 번 더 읽습니다. */
export async function refreshIndexOpsDataFromServer() {
  const tournamentId = getTournamentId();
  if (!tournamentId || isFirestoreQuotaCoolingDown()) return;

  try {
    const snap = await getDocsFromServer(globalWaitingCollectionRef(db, tournamentId));
    const nextWaiting = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

/** 딜러 운영 현황 — 캐시 시드 → Firestore → 출석·명단 일괄 로드 */
export function bootstrapIndexDealerOps(options = {}) {
  const force = options.force === true;
  if (bootstrapInflight) {
    if (!force) return bootstrapInflight;
    return bootstrapInflight.finally(() => {
      bootstrapInflight = null;
      return bootstrapIndexDealerOps();
    });
  }

  const seq = ++bootstrapSeq;
  bootstrapInflight = (async () => {
    seedIndexTournamentMetaFromHubCache();
    seedIndexOpsFromSessionCache();
    await prefetchIndexOpsFromFirestoreCache();
    if (seq !== bootstrapSeq) return;
    await Promise.all([
      refreshIndexOpsDataFromServer(),
      loadDealerAttendanceOnce({ forceServer: true }),
      loadTournamentDealerRosterOnce()
    ]);
    if (isAppDebugEnabled()) {
      console.info("[index-ops-bootstrap]", {
        tournamentId: getTournamentId(),
        requiredCode: String(IX.currentTournament?.requiredCode || "").trim(),
        waiting: IX.globalWaiting.length,
        seats: IX.dealerGlobalSeats.length,
        attendance: IX.dealerAttendanceMap.size,
        roster: IX.tournamentRosterMap.size,
        adminRows: 0
      });
    }
    scheduleRenderDealerOps();
  })()
    .catch((err) => {
      console.warn("bootstrapIndexDealerOps:", err?.code || err);
    })
    .finally(() => {
      if (bootstrapInflight && seq === bootstrapSeq) {
        bootstrapInflight = null;
      }
    });

  return bootstrapInflight;
}
