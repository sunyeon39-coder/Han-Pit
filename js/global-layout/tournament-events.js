import { db } from "../firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GL } from "./state.js";

/** 드롭다운 표시명(제목) → 실제 카드 doc id */
export function resolveEventIdForSave(rawId = "", cachedEvents = []) {
  const raw = String(rawId || "").trim();
  if (!raw) return "";
  if (cachedEvents.some((ev) => String(ev?.id || "").trim() === raw)) return raw;
  const byTitle = cachedEvents.find((ev) => String(ev?.title || "").trim() === raw);
  if (byTitle) return String(byTitle.id || "").trim();
  const byIdCase = cachedEvents.find(
    (ev) => String(ev?.id || "").trim().toLowerCase() === raw.toLowerCase()
  );
  if (byIdCase) return String(byIdCase.id || "").trim();
  return raw;
}

/** tournaments/{tid}/events 스냅샷 → { id, title, boxId }[] */
export async function fetchTournamentEvents() {
  const tid = String(GL.tournamentId || "").trim();
  if (!tid) return [];
  const snap = await getDocs(collection(db, "tournaments", tid, "events"));
  const list = snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      id: d.id,
      title: String(data.title || d.id).trim(),
      boxId: String(data.boxId || "").trim()
    };
  });
  list.sort((a, b) => {
    const ta = a.title || a.id;
    const tb = b.title || b.id;
    if (ta !== tb) return ta.localeCompare(tb, "ko");
    return a.id.localeCompare(b.id);
  });
  return list;
}

/**
 * Seat 수정·추가용 카드 목록 — index 카드 + layout_events 에 등록된 박스까지 합침
 * @returns {Promise<Array<{ id: string, title: string, boxId: string }>>}
 */
export async function fetchEventCardsForSeatEdit() {
  const tid = String(GL.tournamentId || "").trim();
  const byKey = new Map();

  const tournamentEvents = await fetchTournamentEvents();
  for (const ev of tournamentEvents) {
    const id = String(ev.id || "").trim();
    if (!id) continue;
    const boxId = String(ev.boxId || "").trim() || "1";
    byKey.set(`${id}\t${boxId}`, {
      id,
      title: String(ev.title || id).trim(),
      boxId
    });
  }

  try {
    const snap = await getDocs(collection(db, "layout_events"));
    for (const d of snap.docs) {
      const data = d.data() || {};
      const docTid = String(data.tournamentId || "").trim();
      if (tid && docTid && docTid !== tid) continue;
      const id = String(data.eventId || "").trim();
      const boxId = String(data.boxId || "").trim() || "1";
      if (!id) continue;
      const key = `${id}\t${boxId}`;
      if (byKey.has(key)) continue;
      const fromTournament = tournamentEvents.find((ev) => ev.id === id);
      byKey.set(key, {
        id,
        title: String(fromTournament?.title || id).trim(),
        boxId
      });
    }
  } catch (err) {
    console.error("fetchEventCardsForSeatEdit layout_events error:", err);
  }

  const list = [...byKey.values()];
  list.sort((a, b) => {
    const ta = a.title || a.id;
    const tb = b.title || b.id;
    if (ta !== tb) return ta.localeCompare(tb, "ko");
    return a.id.localeCompare(b.id);
  });
  return list;
}
