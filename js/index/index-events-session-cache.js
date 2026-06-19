const INDEX_EVENTS_SESSION_KEY = "hanpit_index_events_v1";
const INDEX_EVENTS_LOCAL_KEY = "hanpit_index_events_ls_v1";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readCacheEntry(raw, tournamentId, maxAgeMs) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (String(o?.tournamentId || "").trim() !== tournamentId) return null;
    const events = Array.isArray(o?.events) ? o.events : null;
    if (!events?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > maxAgeMs) return null;
    return events;
  } catch {
    return null;
  }
}

export function readIndexEventsSessionCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return null;
  try {
    return readCacheEntry(sessionStorage.getItem(INDEX_EVENTS_SESSION_KEY), tid, SESSION_MAX_AGE_MS);
  } catch {
    return null;
  }
}

function readIndexEventsLocalCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return null;
  try {
    return readCacheEntry(localStorage.getItem(INDEX_EVENTS_LOCAL_KEY), tid, LOCAL_MAX_AGE_MS);
  } catch {
    return null;
  }
}

export function readIndexEventsPersistedCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return null;
  return readIndexEventsSessionCache(tid) || readIndexEventsLocalCache(tid);
}

export function readIndexEventsLegacyCache(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  if (!tid) return null;
  try {
    for (const raw of [
      localStorage.getItem(INDEX_EVENTS_LOCAL_KEY),
      sessionStorage.getItem(INDEX_EVENTS_SESSION_KEY)
    ]) {
      if (!raw) continue;
      const o = JSON.parse(raw);
      if (String(o?.tournamentId || "").trim() !== tid) continue;
      const events = Array.isArray(o?.events) ? o.events : null;
      if (events?.length) return events;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeIndexEventsSessionCache(tournamentId = "", events = []) {
  const tid = String(tournamentId || "").trim();
  const list = Array.isArray(events) ? events : [];
  if (!tid || !list.length) return;
  const payload = JSON.stringify({ tournamentId: tid, savedAt: Date.now(), events: list });
  try {
    sessionStorage.setItem(INDEX_EVENTS_SESSION_KEY, payload);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(INDEX_EVENTS_LOCAL_KEY, payload);
  } catch {
    /* ignore */
  }
}
