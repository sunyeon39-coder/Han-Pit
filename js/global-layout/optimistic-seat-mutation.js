import { GL } from "./state.js";
import { auth } from "../firebase.js";
import { bumpGlobalLayoutDataRevision } from "./realtime-ui.js";
import { updateGlobalLayoutWaitingMeta, updateGlobalLayoutMetaCounts } from "./meta-ui.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { renderSeats, refreshGlobalLayoutPcOpsPanel, invalidateWaitingPanelFingerprint } from "./panel-ui.js";
import { renderGlobalLayoutMobile } from "./mobile-panel-render.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { isEmptyPerson } from "./utils.js";
import { rebuildWaitingAfterSeatToWait, resolveReturnToWaitingJoinMs } from "./fs-waiting-merge.js";
import { isPersonSeatedInGlobalSeats } from "./waiting.js";
import { personIdentityMatches } from "../shared/tournament-waiting-queue.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  triggerOptimisticMobileSeatAssignedAlert
} from "../shared/optimistic-seat-assigned-notify.js";

function cloneSeats(seats = []) {
  return seats.map((s) => ({ ...s }));
}

export function flushOptimisticGlobalLayoutUi() {
  bumpGlobalLayoutDataRevision();
  if (layoutIsMobile()) {
    updateGlobalLayoutMetaCounts(GL.globalSeats);
    renderGlobalLayoutMobile({ sync: true });
    updateGlobalLayoutWaitingMeta();
    maybeShowOptimisticSeatAlertFromSeats(GL.globalSeats, {
      user: GL.currentUser || auth.currentUser,
      profile: GL.userProfile,
      buildTargetUrl: (eventId, boxId, seatId) =>
        `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(seatId)}`,
      showAlert: (payload) => triggerOptimisticMobileSeatAssignedAlert(payload)
    });
    return;
  }
  renderSeats(GL.globalSeats);
  refreshGlobalLayoutPcOpsPanel();
  updateGlobalLayoutWaitingMeta();
}

function clearPersonOnSeatInMemory(seat = {}) {
  return {
    ...seat,
    person: "비어있음",
    personUid: "",
    personEmail: "",
    seatedAt: null,
    status: "empty"
  };
}

function matchesPersonOnSeat(seat = {}, person = {}) {
  const sName = String(seat?.person || "").trim();
  if (isEmptyPerson(sName)) return false;
  return personIdentityMatches(person, seat);
}

/** 배치 클릭 직후 화면 반영 — Firestore 완료 전 */
export function applyOptimisticAssign({ targetSeatId, waiting, seat }) {
  const sid = String(targetSeatId || "").trim();
  const snapshot = {
    globalSeats: cloneSeats(GL.globalSeats),
    globalWaiting: [...GL.globalWaiting],
    selectedWaitingId: GL.selectedWaitingId,
    selectedSeatIds: new Set(GL.selectedSeatIds)
  };

  const now = Date.now();
  const waitingId = String(waiting?.id || "").trim();
  const waitingUid = String(waiting?.uid || "").trim();
  const waitingEmail = String(waiting?.email || "").trim();
  const waitingName = String(waiting?.name || "").trim();
  const waitingTournamentId = String(waiting?.tournamentId || GL.tournamentId).trim();

  const incoming = { uid: waitingUid, email: waiting.email, name: waitingName };

  GL.globalSeats = GL.globalSeats.map((s) => {
    const seatId = String(s?.seatId || "").trim();
    if (seatId === sid) return s;
    if (matchesPersonOnSeat(s, incoming)) return clearPersonOnSeatInMemory(s);
    return s;
  });

  const seatIdx = GL.globalSeats.findIndex((s) => String(s?.seatId || "").trim() === sid);
  const target = seatIdx >= 0 ? GL.globalSeats[seatIdx] : seat;
  const prevName = String(target?.person || "").trim();
  const prevUid = String(target?.personUid || "").trim();
  const prevEmail = String(target?.personEmail || "").trim();
  const wasOccupied = !isEmptyPerson(prevName);

  GL.globalWaiting = GL.globalWaiting.filter((w) => {
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

  if (wasOccupied) {
    const prevPerson = { uid: prevUid, email: prevEmail, name: prevName };
    GL.globalSeats = GL.globalSeats.map((s) => {
      const seatId = String(s?.seatId || "").trim();
      if (seatId === sid) return s;
      if (matchesPersonOnSeat(s, prevPerson)) return clearPersonOnSeatInMemory(s);
      return s;
    });

    const others = GL.globalSeats.filter((s) => {
      const seatId = String(s?.seatId || "").trim();
      if (seatId === sid) return false;
      return matchesPersonOnSeat(s, prevPerson);
    });
    const bumpedPrevHasOtherSeat = others.some((s) => !isEmptyPerson(String(s?.person || "").trim()));

    if (!bumpedPrevHasOtherSeat) {
      const returnJoin = resolveReturnToWaitingJoinMs(
        snapshot.globalWaiting,
        GL.tournamentId,
        prevPerson,
        now,
        GL.attendanceByUid
      );
      GL.globalWaiting = rebuildWaitingAfterSeatToWait(
        GL.globalWaiting,
        GL.tournamentId,
        prevPerson,
        returnJoin,
        { source: "seat_swap", preserveJoinedAt: returnJoin, attendanceByUid: GL.attendanceByUid }
      );
    }
  }

  const nextTarget = {
    ...target,
    person: waitingName || waitingUid || "-",
    personUid: waitingUid,
    personEmail: String(waiting?.email || "").trim(),
    seatedAt: now,
    status: "occupied"
  };
  if (seatIdx >= 0) GL.globalSeats[seatIdx] = nextTarget;
  else GL.globalSeats.push(nextTarget);

  GL.selectedWaitingId = "";
  GL.selectedSeatIds.clear();
  GL.selectedSeatIds.add(sid);
  invalidateWaitingPanelFingerprint();

  return () => {
    GL.globalSeats = snapshot.globalSeats;
    GL.globalWaiting = snapshot.globalWaiting;
    GL.selectedWaitingId = snapshot.selectedWaitingId;
    GL.selectedSeatIds = snapshot.selectedSeatIds;
  };
}

/** 비우기 클릭 직후 화면 반영 */
export function applyOptimisticClear({ targetSeatId, seat }) {
  const sid = String(targetSeatId || "").trim();
  const snapshot = {
    globalSeats: cloneSeats(GL.globalSeats),
    globalWaiting: [...GL.globalWaiting],
    selectedSeatIds: new Set(GL.selectedSeatIds)
  };

  const seatIdx = GL.globalSeats.findIndex((s) => String(s?.seatId || "").trim() === sid);
  const target = seatIdx >= 0 ? GL.globalSeats[seatIdx] : seat;
  const prevUid = String(target?.personUid || "").trim();
  const prevEmail = String(target?.personEmail || "").trim();
  const prevName = String(target?.person || "").trim();
  const now = Date.now();

  if (seatIdx >= 0) {
    GL.globalSeats[seatIdx] = clearPersonOnSeatInMemory(target);
  }

  if (!isEmptyPerson(prevName)) {
    const prevPerson = { uid: prevUid, email: prevEmail, name: prevName };
    const hasOtherSeat = isPersonSeatedInGlobalSeats(
      GL.globalSeats.filter((s) => String(s?.seatId || "").trim() !== sid),
      prevPerson
    );
    if (!hasOtherSeat) {
      const returnJoin = resolveReturnToWaitingJoinMs(
        snapshot.globalWaiting,
        GL.tournamentId,
        prevPerson,
        now,
        GL.attendanceByUid
      );
      GL.globalWaiting = rebuildWaitingAfterSeatToWait(
        GL.globalWaiting,
        GL.tournamentId,
        prevPerson,
        returnJoin,
        { source: "seat_clear", preserveJoinedAt: returnJoin, attendanceByUid: GL.attendanceByUid }
      );
    }
  }

  GL.selectedSeatIds.delete(sid);

  return () => {
    GL.globalSeats = snapshot.globalSeats;
    GL.globalWaiting = snapshot.globalWaiting;
    GL.selectedSeatIds = snapshot.selectedSeatIds;
  };
}
