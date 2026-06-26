import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceDocId } from "./dealer-attendance-refs.js";
import { applyOperationalDayToAttendance, isAttendanceFromCurrentOperationalDay, isActiveAttendanceStatus } from "../shared/attendance-operational-day.js";
import {
  findGlobalWaitingRowForUid,
  getWaitingRowJoinMs
} from "../shared/tournament-waiting-queue.js";

export function getBaseAttendance(user) {
  if (!user) return null;
  const tournamentId = getTournamentId();
  return IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, user.uid)) || null;
}

export function isAttendanceTerminal(status) {
  const s = String(status || "").trim();
  return s === "checked_out" || s === "off";
}

function overlayWaitingQueueStatus(user, row = {}) {
  if (!user?.uid || isAttendanceTerminal(row.status)) return row;
  const checkedOutAt = Number(row?.checkedOutAt || 0);
  if (checkedOutAt > 0) return row;
  if (String(row.status || "").trim() === "assigned") return row;

  const tournamentId = getTournamentId();
  const waitRow = findGlobalWaitingRowForUid(IX.globalWaiting, tournamentId, user.uid);
  if (!waitRow) return row;

  const joinMs = getWaitingRowJoinMs(waitRow) || null;
  return applyOperationalDayToAttendance({
    ...row,
    status: "waiting",
    checkedInAt: row.checkedInAt || joinMs,
    checkedOutAt: null,
    statusChangedAt: row.statusChangedAt || joinMs,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: ""
  });
}

/** index 이벤트 카드에 없는 eventId 의 좌석은 과거 배치 잔상으로 보고 배치중 판정에서 제외 */
export function seatStillMatchesActiveEventCard(seatInfo) {
  if (!seatInfo) return false;
  const eid = String(seatInfo.eventId || "").trim();
  if (!eid) return false;
  const events = Array.isArray(IX.events) ? IX.events : [];
  return events.some((ev) => String(ev.id || "").trim() === eid);
}

export function getDerivedAttendance(user) {
  if (!user) return null;

  const base = getBaseAttendance(user);
  const seatInfo = IX.dealerSeatMap.get(user.uid);
  /** 퇴근·미출근이면 좌석 무시 */
  const useSeat = Boolean(seatInfo) && !(base && isAttendanceTerminal(base.status));

  if (!base) {
    const seatOnly = Boolean(seatInfo);
    return overlayWaitingQueueStatus(
      user,
      applyOperationalDayToAttendance({
        uid: user.uid,
        nickname: IX.currentUserProfile?.nickname || user.displayName || "Unknown",
        status: seatOnly ? "assigned" : "off",
        checkedInAt: null,
        checkedOutAt: null,
        breakStartedAt: null,
        totalBreakMs: 0,
        currentEventId: seatOnly ? (seatInfo.eventId || "") : "",
        currentBoxId: seatOnly ? (seatInfo.boxId || "") : "",
        currentSeatId: seatOnly ? (seatInfo.seatId || "") : "",
        currentSeatLabel: seatOnly ? (seatInfo.seatLabel || "") : "",
        updatedAt: 0
      })
    );
  }

  return overlayWaitingQueueStatus(
    user,
    applyOperationalDayToAttendance({
      ...base,
      status: useSeat ? "assigned" : base.status,
      currentEventId: useSeat ? (seatInfo.eventId || base.currentEventId || "") : base.currentEventId || "",
      currentBoxId: useSeat ? (seatInfo.boxId || base.currentBoxId || "") : base.currentBoxId || "",
      currentSeatId: useSeat ? (seatInfo.seatId || base.currentSeatId || "") : base.currentSeatId || "",
      currentSeatLabel: useSeat ? (seatInfo.seatLabel || base.currentSeatLabel || "") : base.currentSeatLabel || ""
    })
  );
}

export function getSessionStartMs(item) {
  const status = String(item?.status || "").trim();
  const checkedInAt = Number(item.checkedInAt || 0);
  const checkedOutAt = Number(item.checkedOutAt || 0);
  const statusChangedAt = Number(item.statusChangedAt || 0);
  const now = Date.now();

  if (!isActiveAttendanceStatus(status) && status !== "checked_out") return 0;

  if (isActiveAttendanceStatus(status)) {
    if (checkedOutAt > 0) {
      if (statusChangedAt > checkedOutAt) return statusChangedAt;
      return 0;
    }
    if (checkedInAt && isAttendanceFromCurrentOperationalDay({ checkedInAt }, now)) {
      return checkedInAt;
    }
    if (statusChangedAt && isAttendanceFromCurrentOperationalDay({ checkedInAt: statusChangedAt }, now)) {
      return statusChangedAt;
    }
    return 0;
  }

  if (!checkedInAt || !isAttendanceFromCurrentOperationalDay({ checkedInAt }, now)) return 0;
  return checkedInAt;
}

export function getWorkingMs(item) {
  const startMs = getSessionStartMs(item);
  if (!startMs) return 0;

  const status = String(item?.status || "").trim();
  const end =
    status === "checked_out" && item.checkedOutAt
      ? Number(item.checkedOutAt || 0)
      : Date.now();
  const total = Math.max(0, end - startMs);
  const currentBreak =
    status === "break" && item.breakStartedAt
      ? Math.max(0, Date.now() - Number(item.breakStartedAt || 0))
      : 0;
  return Math.max(0, total - Number(item.totalBreakMs || 0) - currentBreak);
}

export function normalizeAttendanceDoc(data = {}) {
  return {
    uid: String(data.uid || "").trim(),
    nickname: String(data.nickname || "").trim(),
    email: String(data.email || "").trim(),
    tournamentId: String(data.tournamentId || "").trim(),
    status: String(data.status || "off").trim(),
    checkedInAt: Number(data.checkedInAt || 0) || null,
    checkedOutAt: Number(data.checkedOutAt || 0) || null,
    breakStartedAt: Number(data.breakStartedAt || 0) || null,
    totalBreakMs: Number(data.totalBreakMs || 0) || 0,
    currentEventId: String(data.currentEventId || "").trim(),
    currentBoxId: String(data.currentBoxId || "").trim(),
    currentSeatId: String(data.currentSeatId || "").trim(),
    currentSeatLabel: String(data.currentSeatLabel || "").trim(),
    statusChangedAt: Number(data.statusChangedAt || 0) || null,
    updatedAt: Number(data.updatedAt || 0) || 0
  };
}
