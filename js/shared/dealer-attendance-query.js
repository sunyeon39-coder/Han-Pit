import { db } from "../firebase.js";
import {
  collection,
  documentId,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { attendanceDocBelongsToTournament } from "../index/dealer-attendance-refs.js";

/**
 * 대회 단위 구독 — 문서 ID `{tournamentId}__{uid}` 범위 쿼리
 * (tournamentId 필드 누락 레거시 문서·인덱스 이슈 회피)
 */
export function dealerAttendanceQueryForTournament(tournamentId) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return collection(db, "dealer_attendance");
  const start = `${tid}__`;
  const end = `${tid}__\uf8ff`;
  return query(
    collection(db, "dealer_attendance"),
    where(documentId(), ">=", start),
    where(documentId(), "<=", end)
  );
}

export function filterAttendanceDocsForTournament(docs, tournamentId) {
  const tid = String(tournamentId || "").trim();
  if (!tid) return docs;
  return docs.filter((d) => attendanceDocBelongsToTournament(d.id, tid));
}
