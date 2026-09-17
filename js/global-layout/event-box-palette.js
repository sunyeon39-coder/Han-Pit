/** 통합 배치도: eventId + boxId 조합별 Seat 테두리 색 (0~9, 파란 계열 없음) */
export const EVENT_BOX_PALETTE_COUNT = 10;

export function getSeatEventBoxKey(seat = {}) {
  const eventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  const boxId = String(seat.boxId || "").trim();
  if (!eventId || !boxId) return "";
  return `${eventId}\t${boxId}`;
}

/**
 * key(eventId+boxId) → 팔레트 인덱스, 세션 내내 유지되는 배정표.
 * 예전엔 매번 해시(key 문자열 → 숫자)로만 색을 뽑았는데, 팔레트가 10색뿐이라 실제
 * 서로 다른 카드/박스 조합이 10개가 채 안 돼도 해시값이 우연히 겹치면 다른 이벤트인데
 * 같은 색으로 보이는 문제가 있었다("1,2,3은 다른 이벤트인데 색이 겹친다"). 한 번 배정된
 * key는 절대 다시 바뀌지 않고(그 전 렌더링에서 남아있는 DOM과 항상 일치), 새로 보는
 * key만 그 시점에 남은 색 중 하나를 새로 받는다 — 그래서 동시에 존재하는 조합이 팔레트
 * 수(10개)를 넘지 않는 한 서로 겹치지 않는다는 게 보장된다(넘으면 그때부터는 재사용).
 */
const paletteAssignments = new Map();
let nextPaletteSlot = 0;

function ensureAssignedPaletteIndex(key = "") {
  if (paletteAssignments.has(key)) return paletteAssignments.get(key);
  const idx = nextPaletteSlot % EVENT_BOX_PALETTE_COUNT;
  nextPaletteSlot += 1;
  paletteAssignments.set(key, idx);
  return idx;
}

/**
 * 현재 좌석 목록에서 등장하는 event/box 조합을 정렬된 순서로 미리 배정해 둔다 — 처음
 * 보는 key들이 렌더링 순서(배열 순서)가 아니라 사람이 보기 좋은 순서(카드/박스 정렬)로
 * 색을 받게 하기 위한 것일 뿐, 이미 배정된 key는 절대 건드리지 않는다(ensureAssignedPaletteIndex
 * 참고) — 그래서 이 함수를 부분 목록으로 호출해도 기존 색이 흔들리지 않는다.
 */
export function buildEventBoxPaletteMap(seats = []) {
  const keys = new Set();
  for (const seat of seats) {
    const key = getSeatEventBoxKey(seat);
    if (key) keys.add(key);
  }
  const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const key of sorted) ensureAssignedPaletteIndex(key);
  return paletteAssignments;
}

export function getEventBoxPaletteClass(seat = {}) {
  const key = getSeatEventBoxKey(seat);
  if (!key) return "eb-palette-0";
  return `eb-palette-${ensureAssignedPaletteIndex(key)}`;
}

/** eventId+boxId 조합 → 항상 동일한 팔레트 (날짜·화면 구성과 무관, index 배치도 등) */
export function getStableEventBoxPaletteClass(eventId = "", boxId = "") {
  return getEventBoxPaletteClass(
    { currentEventId: String(eventId || "").trim(), boxId: String(boxId || "").trim() },
    null
  );
}
