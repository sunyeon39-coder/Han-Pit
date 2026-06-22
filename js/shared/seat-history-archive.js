import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * 좌석을 삭제했다가 같은 카드ID(eventId)+박스+라벨로 다시 만들면 배치 이력을 이어받도록,
 * 삭제 직전 seatHistory 를 별도 컬렉션(global_seats_archive)에 라벨 기준으로 보관한다.
 * seatId 는 재생성 시 바뀔 수 있으므로 라벨을 안정 키로 쓴다.
 */

export function seatHistoryArchiveLabelKey(label = "") {
  const norm = String(label ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return norm || "_";
}

export function seatHistoryArchiveDocId(eventId = "", boxId = "", label = "") {
  return `${String(eventId || "").trim()}__${String(boxId || "").trim()}__${seatHistoryArchiveLabelKey(label)}`;
}

function archiveCollection(tournamentId) {
  return collection(db, "tournaments", String(tournamentId || "").trim(), "global_seats_archive");
}

/** 삭제되는 좌석의 seatHistory 를 아카이브에 저장(비어 있으면 건너뜀). best-effort. */
export async function archiveSeatHistory(tournamentId, { eventId, boxId, label, seatId, seatHistory } = {}) {
  const tid = String(tournamentId || "").trim();
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!tid || !eid || !bid) return;
  const history = Array.isArray(seatHistory) ? seatHistory.filter((h) => h && typeof h === "object") : [];
  if (!history.length) return;

  const archiveId = seatHistoryArchiveDocId(eid, bid, label);
  try {
    await setDoc(
      doc(db, "tournaments", tid, "global_seats_archive", archiveId),
      {
        eventId: eid,
        boxId: bid,
        label: String(label ?? "").trim(),
        seatId: String(seatId || "").trim(),
        sourceLayoutDocId: `${eid}__${bid}`,
        seatHistory: history,
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp()
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("archiveSeatHistory:", err?.code || err);
  }
}

/** 단일 좌석(카드+박스+라벨)의 아카이브 이력을 복원. 없으면 []. */
export async function loadArchivedSeatHistory(tournamentId, { eventId, boxId, label } = {}) {
  const tid = String(tournamentId || "").trim();
  const eid = String(eventId || "").trim();
  const bid = String(boxId || "").trim();
  if (!tid || !eid || !bid) return [];
  const archiveId = seatHistoryArchiveDocId(eid, bid, label);
  try {
    const snap = await getDoc(doc(db, "tournaments", tid, "global_seats_archive", archiveId));
    if (!snap.exists()) return [];
    const data = snap.data() || {};
    return Array.isArray(data.seatHistory) ? data.seatHistory.filter((h) => h && typeof h === "object") : [];
  } catch (err) {
    console.warn("loadArchivedSeatHistory:", err?.code || err);
    return [];
  }
}

/** layout 문서 단위(eventId__boxId)로 라벨키 → seatHistory 맵을 한 번에 로드. */
export async function loadArchivedSeatHistoryByLayoutDoc(tournamentId, eventDocId) {
  const tid = String(tournamentId || "").trim();
  const layoutDocId = String(eventDocId || "").trim();
  const map = new Map();
  if (!tid || !layoutDocId) return map;
  try {
    const snap = await getDocs(
      query(archiveCollection(tid), where("sourceLayoutDocId", "==", layoutDocId))
    );
    snap.forEach((d) => {
      const data = d.data() || {};
      const key = seatHistoryArchiveLabelKey(data.label);
      const history = Array.isArray(data.seatHistory)
        ? data.seatHistory.filter((h) => h && typeof h === "object")
        : [];
      if (history.length) map.set(key, history);
    });
  } catch (err) {
    console.warn("loadArchivedSeatHistoryByLayoutDoc:", err?.code || err);
  }
  return map;
}
