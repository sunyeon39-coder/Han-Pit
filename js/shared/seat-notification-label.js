import {
  getEventCardIdFromRecord,
  EVENT_INSTANCE_SEP
} from "./tournament-event-instance.js";

/** 배치 알림·푸시에 표시할 카드 ID (설정 cardId 우선). */
export function resolveSeatNotificationCardLabel({
  eventId = "",
  eventTitle = "",
  cardId = ""
} = {}) {
  const explicit = String(cardId || "").trim();
  if (explicit) return explicit;

  const eid = String(eventId || "").trim();
  if (eid) {
    const fromEventId = getEventCardIdFromRecord({ id: eid });
    if (fromEventId) return fromEventId;
  }

  const stored = String(eventTitle || "").trim();
  if (stored.includes(EVENT_INSTANCE_SEP)) {
    const fromStored = getEventCardIdFromRecord({ id: stored });
    if (fromStored) return fromStored;
  }
  if (stored) return stored;

  return eid || "이벤트";
}

export function buildSeatAssignedNotifyMessage({
  eventId = "",
  eventTitle = "",
  cardId = "",
  seatLabel = ""
} = {}) {
  const label = resolveSeatNotificationCardLabel({
    eventId,
    eventTitle,
    cardId
  });
  const seat = String(seatLabel || "").trim();
  if (!seat) return `${label}에 배치되었습니다.`;
  return `${label} / Seat ${seat}에 배치되었습니다.`;
}
