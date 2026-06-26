import { auth, db } from "../firebase.js";
import {
  collection,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  dealerAttendanceQueryForTournament,
  filterAttendanceDocsForTournament
} from "../shared/dealer-attendance-query.js";

import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { indexCanUseTournamentOps } from "./index-ops-tournament-meta.js";
import {
  buildSeatAssignmentStableKey,
  triggerOptimisticMobileSeatAssignedAlert,
  RECENT_SEAT_ASSIGN_ALERT_MS
} from "../shared/optimistic-seat-assigned-notify.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import {
  getAttendanceDocId,
  getAttendanceRef,
  parseTournamentIdFromAttendanceDocId
} from "./dealer-attendance-refs.js";
import { normalizeAttendanceDoc } from "./dealer-attendance-derived.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";
import { loadDealerAttendanceOnce } from "./dealer-attendance-load-once.js";
import { ensureMeRecovered } from "./dealer-attendance-recovery.js";
import { maybeResetMyStaleOperationalDayAttendance } from "./dealer-attendance-operational-day-reset.js";
import { writeGlobalSeatsCache } from "./index-ops-session-cache.js";

let lastDealerAttendanceFp = "";
let lastDealerSeatMapFp = "";

function dealerAttendanceFingerprint() {
  const parts = [];
  IX.dealerAttendanceMap.forEach((v, k) => {
    parts.push(
      `${k}:${String(v?.status || "")}:${String(v?.nickname || v?.name || "")}:${Number(v?.checkedInAt || 0)}:${Number(v?.checkedOutAt || 0)}`
    );
  });
  return parts.sort().join("|");
}

function dealerSeatMapFingerprint() {
  const parts = [];
  IX.dealerSeatMap.forEach((v, k) => {
    parts.push(
      `${k}:${String(v?.seatId || "")}:${String(v?.eventId || "")}:${String(v?.boxId || "")}:${Number(v?.seatedAt || 0)}`
    );
  });
  return parts.sort().join("|");
}

function scheduleDealerOpsIfChanged(nextFp, storeKey = "attendance") {
  if (storeKey === "attendance") {
    if (nextFp === lastDealerAttendanceFp) return;
    lastDealerAttendanceFp = nextFp;
  } else {
    if (nextFp === lastDealerSeatMapFp) return;
    lastDealerSeatMapFp = nextFp;
  }
  scheduleRenderDealerOps();
}

function maybeTriggerOptimisticSeatAlertFromDealerSeatMap(user, previousSeatKey = "") {
  if (!layoutIsMobile() || !user?.uid) return previousSeatKey;

  const mine = IX.dealerSeatMap.get(user.uid);
  if (!mine) return previousSeatKey;

  const nextKey = buildSeatAssignmentStableKey({
    uid: user.uid,
    eventId: mine.eventId,
    boxId: mine.boxId,
    seatId: mine.seatId
  });
  if (!nextKey || nextKey === previousSeatKey) return previousSeatKey;

  const tournamentId = getTournamentId();
  const seatedAt = Number(mine.seatedAt || 0);
  const recentAssign =
    seatedAt > 0 && Date.now() - seatedAt <= RECENT_SEAT_ASSIGN_ALERT_MS;
  const seatChangedWhileOpen = !!previousSeatKey;

  if (seatChangedWhileOpen || recentAssign) {
    const qs = tournamentId
      ? `tournamentId=${encodeURIComponent(tournamentId)}&eventId=${encodeURIComponent(mine.eventId)}&boxId=${encodeURIComponent(mine.boxId)}&focusSeatId=${encodeURIComponent(mine.seatId)}`
      : `eventId=${encodeURIComponent(mine.eventId)}&boxId=${encodeURIComponent(mine.boxId)}&focusSeatId=${encodeURIComponent(mine.seatId)}`;
    triggerOptimisticMobileSeatAssignedAlert({
      uid: user.uid,
      eventId: mine.eventId,
      boxId: mine.boxId,
      seatId: mine.seatId,
      seatLabel: mine.seatLabel,
      targetUrl: `./layout.html?${qs}`
    });
  }

  return nextKey;
}

/** global-layout 좌석 캐시·세션 시드 — IX.dealerGlobalSeats / dealerSeatMap 반영 */
export function applyIndexOpsSeatsFromGlRows(rows = [], { scheduleRender = true } = {}) {
  IX.dealerSeatMap.clear();
  IX.dealerGlobalSeats = [];

  for (const data of rows || []) {
    const person = String(data?.person || "").trim();
    if (!person || person === "비어있음") continue;

    IX.dealerGlobalSeats.push({
      person,
      personUid: String(data?.personUid || "").trim(),
      personEmail: String(data?.personEmail || "").trim()
    });

    const uid = String(data?.personUid || "").trim();
    if (!uid) continue;
    IX.dealerSeatMap.set(uid, {
      eventId: String(data?.currentEventId || data?.mappedEventId || "").trim(),
      boxId: String(data?.boxId || "").trim(),
      seatId: String(data?.seatId || "").trim(),
      seatLabel: String(data?.label || data?.no || "").trim(),
      seatedAt: Number(data?.seatedAt || 0) || 0
    });
  }

  if (scheduleRender) scheduleRenderDealerOps();
}

export function bindDealerAttendanceRealtime() {
  const user = auth.currentUser;
  if (!user) return;

  if (IX.stopDealerAttendanceWatch) {
    IX.stopDealerAttendanceWatch();
    IX.stopDealerAttendanceWatch = null;
  }

  const tournamentId = getTournamentId();
  if (indexCanUseTournamentOps(user)) {
    IX.stopDealerAttendanceWatch = onSnapshot(
      dealerAttendanceQueryForTournament(tournamentId),
      (snap) => {
        const tournamentId = getTournamentId();
        if (!tournamentId) {
          scheduleRenderDealerOps();
          return;
        }
        if (snap.empty && snap.metadata?.fromCache && IX.dealerAttendanceMap.size > 0) {
          return;
        }

        IX.dealerAttendanceMap.clear();
        filterAttendanceDocsForTournament(snap.docs, tournamentId).forEach((d) => {
          const raw = d.data() || {};
          const forcedTid = parseTournamentIdFromAttendanceDocId(d.id) || tournamentId;
          const data = normalizeAttendanceDoc({ ...raw, tournamentId: forcedTid });
          IX.dealerAttendanceMap.set(d.id, data);
        });

        scheduleDealerOpsIfChanged(dealerAttendanceFingerprint(), "attendance");
        void maybeResetMyStaleOperationalDayAttendance(user);
      },
      (err) => {
        console.error("bindDealerAttendanceRealtime(admin) error:", err);
        void loadDealerAttendanceOnce();
      }
    );
    return;
  }

  if (!tournamentId) return;

  IX.stopDealerAttendanceWatch = onSnapshot(
    getAttendanceRef(tournamentId, user.uid),
    (snap) => {
        IX.dealerAttendanceMap.delete(getAttendanceDocId(tournamentId, user.uid));

      if (snap.exists()) {
        const data = normalizeAttendanceDoc(snap.data() || {});
        IX.dealerAttendanceMap.set(snap.id, data);
      }

      scheduleDealerOpsIfChanged(dealerAttendanceFingerprint(), "attendance");
      void maybeResetMyStaleOperationalDayAttendance(user);
    },
    (err) => {
      console.error("bindDealerAttendanceRealtime(user) error:", err);
      void loadDealerAttendanceOnce();
    }
  );
}

export function applyIndexGlobalSeatsSnapshot(snap) {
  if (snap.empty && snap.metadata?.fromCache && IX.dealerGlobalSeats.length > 0) {
    return;
  }
  IX.dealerSeatMap.clear();
  IX.dealerGlobalSeats = [];

  snap.docs.forEach((d) => {
    const data = d.data() || {};
    const person = String(data.person || "").trim();
    if (!person || person === "비어있음") return;

    IX.dealerGlobalSeats.push({
      person,
      personUid: String(data.personUid || "").trim(),
      personEmail: String(data.personEmail || "").trim()
    });

    const uid = String(data.personUid || "").trim();
    if (!uid) return;
    IX.dealerSeatMap.set(uid, {
      eventId: String(data.currentEventId || data.mappedEventId || "").trim(),
      boxId: String(data.boxId || "").trim(),
      seatId: String(data.seatId || "").trim(),
      seatLabel: String(data.label || data.no || "").trim(),
      seatedAt: Number(data.seatedAt || 0) || 0
    });
  });

  const user = auth.currentUser;
  IX.lastOptimisticSeatAlertKey = maybeTriggerOptimisticSeatAlertFromDealerSeatMap(
    user,
    String(IX.lastOptimisticSeatAlertKey || "")
  );

  void ensureMeRecovered(auth.currentUser);
  scheduleDealerOpsIfChanged(dealerSeatMapFingerprint(), "seat");

  const tid = getTournamentId();
  if (tid && !snap.metadata?.fromCache) {
    const cacheRows = [];
    snap.docs.forEach((d) => {
      const data = d.data() || {};
      cacheRows.push({
        seatId: String(data.seatId || d.id || "").trim(),
        person: String(data.person || "").trim(),
        personUid: String(data.personUid || "").trim(),
        personEmail: String(data.personEmail || "").trim(),
        currentEventId: String(data.currentEventId || data.mappedEventId || "").trim(),
        boxId: String(data.boxId || "").trim(),
        label: String(data.label || data.no || "").trim(),
        seatedAt: Number(data.seatedAt || 0) || 0
      });
    });
    writeGlobalSeatsCache(tid, cacheRows);
  }
}

export function bindDealerSeatRealtime() {
  if (IX.stopDealerSeatWatch) {
    IX.stopDealerSeatWatch();
    IX.stopDealerSeatWatch = null;
  }

  const tournamentId = getTournamentId();
  if (tournamentId) {
    /* global_seats 는 bindLayoutSeatSummaryRealtime 에서 1회만 구독 */
    return;
  }

  IX.stopDealerSeatWatch = onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      IX.dealerSeatMap.clear();

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const eventId = String(data.eventId || "").trim();
        const boxId = String(data.boxId || "").trim();
        const seats = Array.isArray(data.seats) ? data.seats : [];

        seats.forEach((seat) => {
          const uid = String(seat?.personUid || "").trim();
          const person = String(seat?.person || "").trim();
          if (!uid || !person || person === "비어있음") return;

          IX.dealerSeatMap.set(uid, {
            eventId,
            boxId,
            seatId: String(seat?.id || "").trim(),
            seatLabel: String(seat?.label ?? seat?.no ?? "")
          });
        });
      });

      void ensureMeRecovered(auth.currentUser);
      scheduleDealerOpsIfChanged(dealerSeatMapFingerprint(), "seat");
    },
    (err) => {
      console.error("bindDealerSeatRealtime(layout_events) error:", err);
    }
  );
}
