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

/**
 * 항상 key 자체에서만 색을 뽑는다(같은 카드/박스는 항상 같은 색).
 * 예전에는 현재 화면에 있는 좌석들의 key 정렬 순서로 색을 매겼는데(paletteMap),
 * 캔버스가 바뀐 Seat만 부분적으로 다시 그리다 보니 같은 카드+박스인데도
 * 어떤 좌석은 예전 렌더링 때의 색이 그대로 남아있어 서로 다른 색으로 보이는
 * 문제가 있었다. paletteMap 인자는 이전 호출부와의 호환을 위해 남겨두되 더는 쓰지 않는다.
 */
export function getEventBoxPaletteClass(seat = {}) {
  const key = getSeatEventBoxKey(seat);
  if (!key) return "eb-palette-0";
  return `eb-palette-${fallbackPaletteIndex(key)}`;
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
