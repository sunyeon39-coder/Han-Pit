import { globalWaitingDocRef } from "../shared/tournament-waiting-queue.js";
import { waitingRowMatchesPerson } from "./fs-waiting-merge.js";

/**
 * 메모리상의 GL.globalWaiting(또는 그 시점의 배열 스냅샷)에서 이 사람과 일치하는
 * 대기자 문서 참조를 찾는다 — seat-candidates.js의 getCandidateSeatRefsForPerson과
 * 동일한 패턴: 트랜잭션 밖에서 후보 문서 ID를 추려두고, 트랜잭션 안에서 tx.get()으로
 * 다시 확인한다(문서 하나하나만 읽으므로 컬렉션 전체를 트랜잭션으로 조회할 필요가 없다).
 */
export function findGlobalWaitingEntryRefs(db, tournamentId, globalWaitingRows = [], person = {}, excludeId = "") {
  const ex = String(excludeId || "").trim();
  const seen = new Set();
  const refs = [];
  for (const row of globalWaitingRows || []) {
    const rid = String(row?.id || "").trim();
    if (!rid || rid === ex || seen.has(rid)) continue;
    if (!waitingRowMatchesPerson(row, tournamentId, person)) continue;
    seen.add(rid);
    refs.push(globalWaitingDocRef(db, tournamentId, rid));
  }
  return refs;
}

/**
 * 배열 기반 순수 함수(rebuildWaitingAfterSeatToWait, dedupeGlobalWaitingRows 등)의
 * 전/후 결과를 비교해서 실제로 바뀐 문서만 추려낸다 — 트랜잭션(tx.set/tx.delete)과
 * 일반 쓰기(setDoc/deleteDoc) 양쪽에서 재사용한다.
 */
export function diffGlobalWaitingRows(prevArr = [], nextArr = []) {
  const prevById = new Map((prevArr || []).map((r) => [String(r?.id || "").trim(), r]));
  const nextById = new Map((nextArr || []).map((r) => [String(r?.id || "").trim(), r]));
  const toSet = [];
  const toDelete = [];
  for (const [id, row] of nextById) {
    if (!id) continue;
    const prev = prevById.get(id);
    if (prev && JSON.stringify(prev) === JSON.stringify(row)) continue;
    const { id: _drop, ...data } = row;
    toSet.push({ id, data });
  }
  for (const id of prevById.keys()) {
    if (!id || nextById.has(id)) continue;
    toDelete.push(id);
  }
  return { toSet, toDelete };
}
