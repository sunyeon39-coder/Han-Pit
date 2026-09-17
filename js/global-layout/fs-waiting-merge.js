import { getWaitingRowJoinMs } from "../shared/tournament-waiting-queue.js";
import { resolveAttendanceWaitingJoinMs } from "../shared/attendance-operational-day.js";

/**
 * "이 사람의 대기 문서 id는 이거다" — 서버(functions/index.js의 finalizeOneIncomingSwap이
 * 쓰는 manualWaitingIdForName/`w_${uid}` 패턴)와 반드시 똑같아야 한다. 예전엔 클라이언트
 * 쪽 좌석→대기 복귀 로직들이 로컬 배열에서 못 찾으면 각자 랜덤 id(makeUid("wait"))로 새
 * 문서를 만들었는데, 그러면 나중에 서버 finalize가 같은 사람을 위해 결정적 id로 또 다른
 * 문서를 만들어 — 한 사람 앞으로 대기 문서가 여러 개(잔상) 쌓이는 원인이 됐다. 이제부터는
 * 로컬에서 기존 행을 못 찾았을 때도 항상 이 결정적 id로 수렴하게 한다.
 */
export function resolveCanonicalWaitingDocId(person = {}) {
  const uid = String(person?.uid || "").trim();
  if (uid) return `w_${uid}`;
  const safeName = String(person?.name || "")
    .trim()
    .replace(/[/\s]+/g, "_")
    .slice(0, 120);
  return `w_manual_${safeName || "unnamed"}`;
}

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
  const id = String(
    extraFields.id || prev?.id || resolveCanonicalWaitingDocId({ uid: prevUid, name: prevName })
  ).trim();
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
  // carryOverConfirmAt — 교대 확정 대기(incomingPerson) 취소 등으로 대기로 되돌릴 때, 원래
  // 배치확인이 걸렸던 시각을 이 대기 문서에 실어 둔다. 나중에 이 사람이 다른 좌석에 다시
  // 배치확인되면(assignSelectedWaitingToSeat) 이 값을 이어받아 incomingAt/seatedAt으로 써서,
  // "0~5분 사이 뺐다가 다른 곳에 다시 넣으면 타이머가 리셋되지 않고 이어진다"를 만족한다.
  // extraFields에서 안 넘어오면 항상 null로 명시해서 쓴다 — 안 그러면 merge:true 쓰기라
  // 예전에 실렸던 값이 관계없는 다음 배치까지 그대로 남아 잘못 이어붙는 문제가 생긴다.
  const carryOverConfirmAt = Number(restExtra.carryOverConfirmAt) > 0 ? Number(restExtra.carryOverConfirmAt) : null;

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
      ...restExtra,
      carryOverConfirmAt
    }
  ];
}
