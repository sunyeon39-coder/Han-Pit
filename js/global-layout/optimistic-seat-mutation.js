import { GL } from "./state.js";
import { auth } from "../firebase.js";
import { bumpGlobalLayoutDataRevision } from "./realtime-ui.js";
import { updateGlobalLayoutWaitingMeta, updateGlobalLayoutMetaCounts } from "./meta-ui.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { renderSeats, refreshGlobalLayoutPcOpsPanel, invalidateWaitingPanelFingerprint } from "./panel-ui.js";
import { renderGlobalLayoutMobile } from "./mobile-panel-render.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import { isEmptyPerson } from "./utils.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
import { isPersonSeatedInGlobalSeats } from "./waiting.js";
import { personIdentityMatches } from "../shared/tournament-waiting-queue.js";
import {
  maybeShowOptimisticSeatAlertFromSeats,
  triggerOptimisticMobileSeatAssignedAlert
} from "../shared/optimistic-seat-assigned-notify.js";
import { buildSeatAssignedTargetUrl, SEAT_SWAP_REVEAL_DELAY_MS } from "../shared/seat-notification-push.js";

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
      buildTargetUrl: (eventId, boxId) => buildSeatAssignedTargetUrl(GL.tournamentId, eventId, boxId),
      showAlert: (payload) => triggerOptimisticMobileSeatAssignedAlert(payload),
      revealDelayMs: SEAT_SWAP_REVEAL_DELAY_MS
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
    status: "empty",
    // previousPerson 을 지우지 않으면(스왑 표시용 필드) 좌석이 실제로는 비었는데도
    // 딜러 명단(현재/다음)이 그 사람을 계속 붙잡고 보여주는 원인이 된다.
    previousPerson: "",
    previousPersonUid: "",
    previousPersonEmail: "",
    // 교대 확정 대기 중이던 사람도 좌석이 통째로 비면 같이 지운다(호출부에서 대기로 복원).
    incomingPerson: "",
    incomingPersonUid: "",
    incomingPersonEmail: "",
    incomingAt: null
  };
}

function matchesPersonOnSeat(seat = {}, person = {}) {
  const sName = String(seat?.person || "").trim();
  if (isEmptyPerson(sName)) return false;
  return personIdentityMatches(person, seat);
}

/**
 * 배치 클릭 직후 화면 반영 — Firestore 완료 전.
 * 좌석이 이미 점유돼 있으면(스왑) 실제 occupant는 그대로 두고 incomingPerson/incomingAt
 * 으로만 "10분 뒤 확정 예정"을 표시한다 — 실제 person 필드는 finalize(서버 스케줄러)
 * 전까지 바뀌지 않는다. 빈 좌석에 새로 배치하는 경우만 기존처럼 즉시 반영한다.
 * immediate:true("즉시확인")면 스왑이어도 예약 없이 실제 occupant를 바로 교체하고,
 * 밀려나는 기존 점유자를 대기열로 즉시 되돌린다.
 */
export function applyOptimisticAssign({ targetSeatId, waiting, seat, now: nowOverride = 0, immediate = false }) {
  const sid = String(targetSeatId || "").trim();
  const snapshot = {
    globalSeats: cloneSeats(GL.globalSeats),
    globalWaiting: [...GL.globalWaiting],
    selectedWaitingId: GL.selectedWaitingId,
    selectedSeatIds: new Set(GL.selectedSeatIds)
  };

  const now = Number(nowOverride) || Date.now();
  const waitingId = String(waiting?.id || "").trim();
  const waitingUid = String(waiting?.uid || "").trim();
  const waitingEmail = String(waiting?.email || "").trim();
  const waitingName = String(waiting?.name || "").trim();
  const waitingTournamentId = String(waiting?.tournamentId || GL.tournamentId).trim();

  const incoming = { uid: waitingUid, email: waiting.email, name: waitingName };

  // 새로 배치되는 사람이 다른 좌석에 이미 앉아 있었다면(중복) 그 좌석은 항상 비운다.
  GL.globalSeats = GL.globalSeats.map((s) => {
    const seatId = String(s?.seatId || "").trim();
    if (seatId === sid) return s;
    if (matchesPersonOnSeat(s, incoming)) return clearPersonOnSeatInMemory(s);
    return s;
  });

  const seatIdx = GL.globalSeats.findIndex((s) => String(s?.seatId || "").trim() === sid);
  const target = seatIdx >= 0 ? GL.globalSeats[seatIdx] : seat;
  const prevName = String(target?.person || "").trim();
  const wasOccupied = !isEmptyPerson(prevName);

  // 배정 대상은 대기열에서 "찜된" 상태이니 화면에서도 바로 사라져야 한다.
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

  const existingIncomingAt = Number(target?.incomingAt) || 0;
  const hadExistingIncoming = !isEmptyPerson(String(target?.incomingPerson || "").trim());
  // 0~5분 사이 다른 좌석에서 취소된 배치확인이었다면 그때 실렸던 원래 확정 시각을
  // 이어받는다(fs-assign-waiting-to-seat.js와 동일 규칙) — 즉시확인은 예약 개념이 없다.
  const carryOverConfirmAt = !immediate ? Number(waiting?.carryOverConfirmAt) || 0 : 0;
  const nextTarget =
    wasOccupied && !immediate
      ? {
          ...target,
          incomingPerson: waitingName || waitingUid || "-",
          incomingPersonUid: waitingUid,
          incomingPersonEmail: waitingEmail,
          // 이미 다른 사람이 확정 대기 중이던 좌석에서 선택을 바꾸는 거라면, 그 사람의
          // incomingAt을 그대로 물려받는다 — 안 그러면 바꿀 때마다 10분 카운트가 새로
          // 시작돼서 실제 확정이 계속 미뤄진다(fs-assign-waiting-to-seat.js와 동일 규칙).
          incomingAt:
            hadExistingIncoming && existingIncomingAt > 0
              ? existingIncomingAt
              : carryOverConfirmAt > 0
                ? carryOverConfirmAt
                : now,
          instantConfirm: false
        }
      : {
          ...target,
          person: waitingName || waitingUid || "-",
          personUid: waitingUid,
          personEmail: waitingEmail,
          seatedAt: carryOverConfirmAt > 0 ? carryOverConfirmAt : now,
          status: "occupied",
          instantConfirm: immediate,
          incomingPerson: "",
          incomingPersonUid: "",
          incomingPersonEmail: "",
          incomingAt: null
        };
  if (seatIdx >= 0) GL.globalSeats[seatIdx] = nextTarget;
  else GL.globalSeats.push(nextTarget);

  // immediate 스왑 — 밀려나는 기존 점유자를 대기열로 바로 되돌린다(다른 좌석에 이미
  // 앉아있지 않은 경우만; clearSeat 낙관적 반영과 동일한 판단 기준).
  if (wasOccupied && immediate && !isEmptyPerson(prevName)) {
    const prevPerson = {
      uid: String(target?.personUid || "").trim(),
      email: String(target?.personEmail || "").trim(),
      name: prevName
    };
    const hasOtherSeat = isPersonSeatedInGlobalSeats(
      GL.globalSeats.filter((s) => String(s?.seatId || "").trim() !== sid),
      prevPerson
    );
    if (!hasOtherSeat) {
      GL.globalWaiting = rebuildWaitingAfterSeatToWait(
        GL.globalWaiting,
        GL.tournamentId,
        prevPerson,
        now,
        { source: "seat_swap_immediate", resetJoinedAt: true }
      );
    }
  }

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

/** 교대 확정 대기(incomingPerson) 취소 클릭 직후 화면 반영 — 실제 occupant는 안 바뀐다 */
export function applyOptimisticCancelIncomingSwap({ targetSeatId, seat }) {
  const sid = String(targetSeatId || "").trim();
  const snapshot = {
    globalSeats: cloneSeats(GL.globalSeats),
    globalWaiting: [...GL.globalWaiting]
  };

  const seatIdx = GL.globalSeats.findIndex((s) => String(s?.seatId || "").trim() === sid);
  const target = seatIdx >= 0 ? GL.globalSeats[seatIdx] : seat;
  const incomingUid = String(target?.incomingPersonUid || "").trim();
  const incomingEmail = String(target?.incomingPersonEmail || "").trim();
  const incomingName = String(target?.incomingPerson || "").trim();
  const cancelledIncomingAt = Number(target?.incomingAt) || 0;
  const now = Date.now();

  if (seatIdx >= 0) {
    GL.globalSeats[seatIdx] = {
      ...target,
      incomingPerson: "",
      incomingPersonUid: "",
      incomingPersonEmail: "",
      incomingAt: null
    };
  }

  if (!isEmptyPerson(incomingName)) {
    GL.globalWaiting = rebuildWaitingAfterSeatToWait(
      GL.globalWaiting,
      GL.tournamentId,
      { uid: incomingUid, email: incomingEmail, name: incomingName },
      now,
      {
        source: "incoming_swap_cancelled",
        resetJoinedAt: true,
        carryOverConfirmAt: cancelledIncomingAt > 0 ? cancelledIncomingAt : null
      }
    );
  }

  invalidateWaitingPanelFingerprint();

  return () => {
    GL.globalSeats = snapshot.globalSeats;
    GL.globalWaiting = snapshot.globalWaiting;
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
  const incomingUid = String(target?.incomingPersonUid || "").trim();
  const incomingEmail = String(target?.incomingPersonEmail || "").trim();
  const incomingName = String(target?.incomingPerson || "").trim();
  const cancelledIncomingAt = Number(target?.incomingAt) || 0;
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
      GL.globalWaiting = rebuildWaitingAfterSeatToWait(
        GL.globalWaiting,
        GL.tournamentId,
        prevPerson,
        now,
        { source: "seat_clear", resetJoinedAt: true }
      );
    }
  }
  if (!isEmptyPerson(incomingName)) {
    GL.globalWaiting = rebuildWaitingAfterSeatToWait(
      GL.globalWaiting,
      GL.tournamentId,
      { uid: incomingUid, email: incomingEmail, name: incomingName },
      now,
      {
        source: "incoming_swap_cancelled",
        resetJoinedAt: true,
        carryOverConfirmAt: cancelledIncomingAt > 0 ? cancelledIncomingAt : null
      }
    );
  }

  GL.selectedSeatIds.delete(sid);

  return () => {
    GL.globalSeats = snapshot.globalSeats;
    GL.globalWaiting = snapshot.globalWaiting;
    GL.selectedSeatIds = snapshot.selectedSeatIds;
  };
}
