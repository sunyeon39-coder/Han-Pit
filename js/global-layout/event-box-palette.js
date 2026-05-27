/** 통합 배치도: eventId + boxId 조합별 Seat 테두리 색 (0~9, 파란 계열 없음) */
export const EVENT_BOX_PALETTE_COUNT = 10;

export function getSeatEventBoxKey(seat = {}) {
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return "";
  return `${eventId}\t${boxId}`;
}

/** 현재 좌석 목록에서 등장하는 event/box 조합 → 안정적인 팔레트 인덱스 */
export function buildEventBoxPaletteMap(seats = []) {
  const keys = new Set();
  for (const seat of seats) {
    const key = getSeatEventBoxKey(seat);
    if (key) keys.add(key);
  }
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const map = new Map();
  sorted.forEach((key, index) => {
    map.set(key, index % EVENT_BOX_PALETTE_COUNT);
  });
  return map;
}

export function getEventBoxPaletteClass(seat = {}, paletteMap = null) {
  const key = getSeatEventBoxKey(seat);
  if (!key) return "eb-palette-0";
  const idx =
    paletteMap instanceof Map && paletteMap.has(key)
      ? paletteMap.get(key)
      : fallbackPaletteIndex(key);
  return `eb-palette-${idx}`;
}

function fallbackPaletteIndex(key = "") {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % EVENT_BOX_PALETTE_COUNT;
}

/** eventId+boxId 조합 → 항상 동일한 팔레트 (날짜·화면 구성과 무관, index 배치도 등) */
export function getStableEventBoxPaletteClass(eventId = "", boxId = "") {
  return getEventBoxPaletteClass(
    { currentEventId: String(eventId || "").trim(), boxId: String(boxId || "").trim() },
    null
  );
}
