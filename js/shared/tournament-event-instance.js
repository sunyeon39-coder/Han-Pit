import { APP_TIME_ZONE } from "../app_config.js";

export const EVENT_INSTANCE_SEP = "~";

/** 카드/박스 ID에 쓸 수 없는 문자 */
export function isValidEventCardPart(id = "") {
  const value = String(id || "").trim();
  return (
    !!value &&
    !value.includes("/") &&
    !value.includes("__") &&
    !value.includes(EVENT_INSTANCE_SEP)
  );
}

export function normalizeEventCardDate(date = "") {
  return String(date || "")
    .trim()
    .replaceAll(".", "-")
    .replaceAll("/", "-");
}

/** tournaments/.../events 문서 ID — 같은 카드·박스라도 날짜가 다르면 별도 카드 */
export function buildEventInstanceDocId(date = "", cardId = "", boxId = "") {
  const d = normalizeEventCardDate(date);
  const c = String(cardId || "").trim();
  const b = String(boxId || "").trim();
  if (!d || !c || !b) return "";
  return `${d}${EVENT_INSTANCE_SEP}${c}${EVENT_INSTANCE_SEP}${b}`;
}

export function parseEventInstanceDocId(docId = "") {
  const id = String(docId || "").trim();
  if (!id) return null;
  const parts = id.split(EVENT_INSTANCE_SEP);
  if (parts.length !== 3) return null;
  const [date, cardId, boxId] = parts;
  if (!date || !cardId || !boxId) return null;
  return {
    date: normalizeEventCardDate(date),
    cardId: String(cardId).trim(),
    boxId: String(boxId).trim()
  };
}

export function getEventCardIdFromRecord(event = {}) {
  const cardId = String(event?.cardId || "").trim();
  if (cardId) return cardId;
  const parsed = parseEventInstanceDocId(event?.id);
  if (parsed) return parsed.cardId;
  return String(event?.id || "").trim();
}

/**
 * 운영일: 06:00~익일 05:59 는 전날 달력 날짜의 이벤트 카드
 * (예: 5/28 02:00 → 운영일 5/27, 5/28 07:00 → 운영일 5/28)
 */
export function getOperationalEventDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  let y = Number(map.year);
  let m = Number(map.month);
  let d = Number(map.day);
  const hour = Number(map.hour);

  if (hour < 6) {
    const cal = new Date(y, m - 1, d);
    cal.setDate(cal.getDate() - 1);
    y = cal.getFullYear();
    m = cal.getMonth() + 1;
    d = cal.getDate();
  }

  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function filterEventsForOperationalDay(events = [], operationalDate = "") {
  const op = normalizeEventCardDate(
    operationalDate || getOperationalEventDate()
  );
  if (!op) return [...events];
  return events.filter((e) => normalizeEventCardDate(e?.date) === op);
}
