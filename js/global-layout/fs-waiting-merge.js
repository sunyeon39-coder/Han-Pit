import { makeUid } from "./utils.js";

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
 * 배치 해제·스왑 등으로 다시 대기에 들어갈 때: 기존 동일인 행을 제거하고 joinedAt 을 지금으로 새로 넣는다.
 * (배치 중에는 waiting.js 가 좌석 점유로 행을 숨기지만 Firestore 행은 남을 수 있어 joinedAt 이 갱신되지 않던 문제 방지)
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
    ...restExtra
  } = extraFields;
  return [
    ...filtered,
    {
      id,
      uid: prevUid,
      email: prevEmail,
      name: prevName || prevUid || "-",
      tournamentId: tid,
      joinedAt: nowMs,
      ...blockFields,
      ...restExtra
    }
  ];
}
