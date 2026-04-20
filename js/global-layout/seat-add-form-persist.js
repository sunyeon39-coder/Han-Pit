const EVENT_KEY = "globalLayout_seatAdd_eventId";
const BOX_KEY = "globalLayout_seatAdd_boxId";

export function readPersistedSeatAddForm() {
  try {
    const pe = sessionStorage.getItem(EVENT_KEY);
    if (!pe) return null;
    const pb = sessionStorage.getItem(BOX_KEY);
    return { eventId: String(pe).trim(), boxId: pb != null ? String(pb).trim() : "" };
  } catch {
    /* ignore */
  }
  return null;
}

export function writePersistedSeatAddForm(eventId = "", boxId = "") {
  try {
    const id = String(eventId || "").trim();
    if (!id) return;
    sessionStorage.setItem(EVENT_KEY, id);
    sessionStorage.setItem(BOX_KEY, String(boxId ?? "").trim());
  } catch {
    /* ignore */
  }
}
