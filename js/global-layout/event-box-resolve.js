import { GL } from "./state.js";

/**
 * 선택한 카드(eventId)에 맞는 Box ID 결정.
 * 1) 이벤트 문서/행의 boxId
 * 2) 캐시된 events 목록의 해당 카드 boxId
 * 3) 통합 배치도 좌석 중 같은 eventId에서 가장 많이 쓰인 boxId
 */
export function resolveBoxIdForEventId(eventId, eventRow = null, cachedEvents = []) {
  const id = String(eventId || "").trim();
  if (!id) return "";

  const fromRow = eventRow && typeof eventRow === "object" ? String(eventRow.boxId || "").trim() : "";
  if (fromRow) return fromRow;

  const ev = cachedEvents.find((e) => String(e?.id || "").trim() === id);
  const fromList = ev ? String(ev.boxId || "").trim() : "";
  if (fromList) return fromList;

  const counts = new Map();
  for (const s of GL.globalSeats || []) {
    const e = String(s.currentEventId || s.mappedEventId || "").trim();
    if (e !== id) continue;
    const b = String(s.boxId || "").trim();
    if (!b) continue;
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  counts.forEach((n, b) => {
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  });
  return best;
}
