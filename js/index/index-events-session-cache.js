const INDEX_EVENTS_SESSION_KEY = "hanpit_index_events_v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function readIndexEventsSessionCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return null;
  try {
    const raw = sessionStorage.getItem(INDEX_EVENTS_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (String(o?.tournamentId || "").trim() !== tid) return null;
    const events = Array.isArray(o?.events) ? o.events : null;
    if (!events?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > MAX_AGE_MS) return null;
    return events;
  } catch {
    return null;
  }
}

export function writeIndexEventsSessionCache(tournamentId = "", events = []) {
  const tid = String(tournamentId || "").trim();
  const list = Array.isArray(events) ? events : [];
  if (!tid || !list.length) return;
  try {
    sessionStorage.setItem(
      INDEX_EVENTS_SESSION_KEY,
      JSON.stringify({ tournamentId: tid, savedAt: Date.now(), events: list })
    );
  } catch {
    /* ignore */
  }
}
