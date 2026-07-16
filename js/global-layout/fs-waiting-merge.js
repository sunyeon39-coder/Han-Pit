import { makeUid } from "./utils.js";
import { getWaitingRowJoinMs } from "../shared/tournament-waiting-queue.js";
import { resolveAttendanceWaitingJoinMs } from "../shared/attendance-operational-day.js";

/** global_waiting 행이 같은 대회·같은 사람( uid / email / 이름-only )인지 */
export function waitingRowMatchesPerson(w, tournamentId, person) {
  const tid = String(tournamentId || "").trim();
  const prevUid = String(person.uid || "").trim();
  const prevEmail = String(person.email || "").trim();
  const prevName = String(person.name || "").trim();
  const wTournamentId = String(w?.tournamentId || "").trim();
  const sameTournament = !wTournamentId || wTournamentId === tid;
  if (!sameTournament) return false;
  const wUid = String(w?.uid || "").trim();
  const wEmail = String(w?.email || "").trim();
  const wName = String(w?.name || "").trim();
  if (prevUid && wUid && wUid === prevUid) return true;
  if (prevEmail && wEmail && wEmail === prevEmail) return true;
  if (prevName && wName && wName === prevName) return true;
  return false;
}

/**
 * 좌석→대기 복귀 시 원래 대기 순번(joinedAt) 유지 — 스왑 직후 맨 위로 튀는 현상 방지
 */
export function resolveReturnToWaitingJoinMs(
  waitingArr = [],
  tournamentId = "",
  person = {},
  fallbackMs = Date.now(),
  attendanceByUid = null
) {
  const tid = String(tournamentId || "").trim();
  let best = 0;
  for (const w of waitingArr || []) {
    if (!waitingRowMatchesPerson(w, tid, person)) continue;
    const ms = getWaitingRowJoinMs(w);
    if (ms > 0 && (!best || ms < best)) best = ms;
  }
  if (best > 0) return best;

  const uid = String(person?.uid || "").trim();
  if (uid && attendanceByUid instanceof Map) {
    const att = attendanceByUid.get(uid);
    if (att) {
      const attJoin = resolveAttendanceWaitingJoinMs(att);
      if (attJoin > 0) return attJoin;
    }
  }
  return Number(fallbackMs) || Date.now();
}

/**
 * 배치 해제·스왑 등으로 다시 대기에 들어갈 때 joinedAt 결정.
 * seat_clear / seat_swap / seat_removed_recovery → nowMs (타이머 00부터)
 */
export function rebuildWaitingAfterSeatToWait(waitingArr, tournamentId, person, nowMs, extraFields = {}) {
  const tid = String(tournamentId || "").trim();
  const prevRows = (waitingArr || []).filter((w) => waitingRowMatchesPerson(w, tid, person));
  const prev = prevRows[0] || null;
  const filtered = (waitingArr || []).filter((w) => !waitingRowMatchesPerson(w, tid, person));
  const prevUid = String(person.uid || "").trim();
  const prevEmail = String(person.email || "").trim();
  const prevName = String(person.name || "").trim();
  const blockFields =
    prev?.blockChecked === true
      ? {
          blockChecked: true,
          blockCheckedAt: prev.blockCheckedAt ?? nowMs,
          blockAccumulatedMs: Number(prev.blockAccumulatedMs || 0) || 0
        }
      : {
          blockChecked: false,
          blockCheckedAt: null,
          blockAccumulatedMs: Number(prev?.blockAccumulatedMs || 0) || 0
        };
  const id = String(extraFields.id || prev?.id || makeUid("wait")).trim();
  const {
    id: _dropId,
    blockChecked: _dropBlock,
    blockCheckedAt: _dropBlockAt,
    blockAccumulatedMs: _dropBlockMs,
    preserveJoinedAt: _dropPreserveJoin,
    resetJoinedAt: _dropResetJoin,
    attendanceByUid: _dropAttMap,
    ...restExtra
  } = extraFields;
  const source = String(restExtra.source || extraFields.source || "").trim();
  const resetJoin =
    extraFields.resetJoinedAt === true ||
    source === "seat_clear" ||
    source === "seat_swap" ||
    source === "seat_removed_recovery";
  const joinedAt =
    resetJoin
      ? Number(nowMs) || Date.now()
      : Number(extraFields.preserveJoinedAt || 0) ||
        resolveReturnToWaitingJoinMs(
          waitingArr,
          tid,
          person,
          nowMs,
          extraFields.attendanceByUid instanceof Map ? extraFields.attendanceByUid : null
        );
  return [
    ...filtered,
    {
      id,
      uid: prevUid,
      email: prevEmail,
      name: prevName || prevUid || "-",
      tournamentId: tid,
      joinedAt,
      ...blockFields,
      ...restExtra
    }
  ];
}
