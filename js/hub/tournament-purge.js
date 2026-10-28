import { db } from "../firebase.js";
import {
  collection,
  documentId,
  getDocs,
  limit,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/** tournaments/{tid} 아래 하위 컬렉션 — 대회 문서만 지우면 이것들이 남아 같은 ID로 다시 만들 때 예전 내용이 보였다 */
const TOURNAMENT_SUBCOLLECTIONS = [
  "events",
  "global_seats",
  "global_seats_archive",
  "global_waiting",
  "global_waiting_meta",
  "dealer_pay_profiles"
];

const BATCH_LIMIT = 450;

async function deleteRefsInBatches(refs = []) {
  const seen = new Set();
  const uniq = refs.filter((r) => {
    if (!r || seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
  for (let i = 0; i < uniq.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    uniq.slice(i, i + BATCH_LIMIT).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  return uniq.length;
}

/**
 * 대회에 딸린 모든 데이터를 지운다 (시스템 admin 전용 — rules 상 각 컬렉션 delete 권한 필요).
 * - tournaments/{tid}/ 하위 컬렉션 전체
 * - dealer_attendance (문서 ID `${tid}__${uid}` 또는 tournamentId 필드)
 * - dealer_attendance_logs (tournamentId 필드) — 출퇴근·인건비 기록 포함
 * - layout_events (tournamentId 필드; 컬렉션은 대회 간 공유라 해당 대회 것만)
 * 대회 문서 자체와 유저 권한 정리는 호출하는 쪽에서 한다.
 * @returns {Promise<{ deleted: number, failed: string[] }>}
 */
export async function purgeTournamentData(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return { deleted: 0, failed: [] };

  const jobs = [
    ...TOURNAMENT_SUBCOLLECTIONS.map((name) => ({
      label: name,
      queries: [collection(db, "tournaments", tid, name)]
    })),
    {
      label: "dealer_attendance",
      queries: [
        query(collection(db, "dealer_attendance"), where("tournamentId", "==", tid)),
        query(
          collection(db, "dealer_attendance"),
          where(documentId(), ">=", `${tid}__`),
          where(documentId(), "<", `${tid}__`)
        )
      ]
    },
    {
      label: "dealer_attendance_logs",
      queries: [query(collection(db, "dealer_attendance_logs"), where("tournamentId", "==", tid))]
    },
    {
      label: "layout_events",
      queries: [query(collection(db, "layout_events"), where("tournamentId", "==", tid))]
    }
  ];

  let deleted = 0;
  const failed = [];
  for (const job of jobs) {
    try {
      const snaps = await Promise.all(job.queries.map((q) => getDocs(q)));
      deleted += await deleteRefsInBatches(snaps.flatMap((s) => s.docs.map((d) => d.ref)));
    } catch (err) {
      console.error(`[purgeTournamentData] ${job.label}:`, err);
      failed.push(job.label);
    }
  }
  return { deleted, failed };
}

/** 예전에 같은 ID로 쓰다 대회 문서만 지워진 경우 — 남아 있는 데이터가 있는지 가볍게 확인 */
export async function hasLeftoverTournamentData(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return false;
  const probes = [
    ...["events", "global_seats", "global_waiting"].map((name) =>
      query(collection(db, "tournaments", tid, name), limit(1))
    ),
    query(collection(db, "dealer_attendance"), where("tournamentId", "==", tid), limit(1)),
    query(collection(db, "dealer_attendance_logs"), where("tournamentId", "==", tid), limit(1))
  ];
  const snaps = await Promise.all(probes.map((q) => getDocs(q).catch(() => null)));
  return snaps.some((s) => s && !s.empty);
}
