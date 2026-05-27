export {
  buildEventInstanceDocId,
  getEventCardIdFromRecord,
  isValidEventCardPart,
  normalizeEventCardDate
} from "../shared/tournament-event-instance.js";

import { IX } from "./state.js";
import {
  buildEventInstanceDocId,
  normalizeEventCardDate
} from "../shared/tournament-event-instance.js";

/** 폼 값 → Firestore events 문서 ID */
export function resolveEventDocIdFromForm() {
  const cardId = String(IX.eventCardId?.value || "").trim();
  const boxId = String(IX.eventCardBoxId?.value || "").trim();
  const date = normalizeEventCardDate(IX.eventCardDate?.value || "");
  return buildEventInstanceDocId(date, cardId, boxId);
}

/** 삭제·선택 시 우선 doc id (드롭다운) */
export function resolveSelectedEventDocId() {
  const fromSelect = String(IX.eventCardSelect?.value || "").trim();
  if (fromSelect) return fromSelect;
  return resolveEventDocIdFromForm();
}
