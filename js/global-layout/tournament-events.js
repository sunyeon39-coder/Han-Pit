import { db } from "../firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  filterEventsForOperationalDay,
  getEventCardIdFromRecord,
  normalizeEventCardDate
} from "../shared/tournament-event-instance.js";
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
      cardId: getEventCardIdFromRecord({ id: d.id, cardId: data.cardId }),
      title: String(data.title || d.id).trim(),
      boxId: String(data.boxId || "").trim(),
      date: normalizeEventCardDate(data.date || "")
    };
  });
  list.sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da !== db) return da.localeCompare(db);
    const ta = a.title || a.cardId || a.id;
    const tb = b.title || b.cardId || b.id;
    if (ta !== tb) return ta.localeCompare(tb, "ko");
    return a.id.localeCompare(b.id);
  });
  return list;
}

/**
 * Seat 수정·추가용 — 운영일(당일 06:00~익일 05:59) 카드만
 * @returns {Promise<Array<{ id: string, cardId: string, title: string, boxId: string, date: string }>>}
 */
export async function fetchEventCardsForSeatEdit() {
  const list = await fetchTournamentEvents();
  return filterEventsForOperationalDay(list);
}
