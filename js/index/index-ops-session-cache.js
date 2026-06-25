import {
  readGlobalSeatsCache,
  readGlobalSeatsLegacyCache,
  writeGlobalSeatsCache
} from "../global-layout/global-seats-session-cache.js";

const WAITING_SESSION_PREFIX = "hanpit_index_global_waiting_v1_";
const WAITING_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function waitingKeyFor(tournamentId = "") {
  return `${WAITING_SESSION_PREFIX}${String(tournamentId || "na").trim()}`;
}

export { readGlobalSeatsCache, readGlobalSeatsLegacyCache, writeGlobalSeatsCache };

export function readIndexGlobalWaitingCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(waitingKeyFor(id));
    if (!raw) return null;
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.waiting) ? o.waiting : null;
    if (!list?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > WAITING_MAX_AGE_MS) return null;
    return list;
  } catch {
    return null;
  }
}

export function writeIndexGlobalWaitingCache(tournamentId = "", waiting = []) {
  const id = String(tournamentId || "").trim();
  if (!id) return;
  const safe = Array.isArray(waiting) ? waiting : [];
  try {
    if (!safe.length) {
      sessionStorage.removeItem(waitingKeyFor(id));
      return;
    }
    sessionStorage.setItem(
      waitingKeyFor(id),
      JSON.stringify({ savedAt: Date.now(), waiting: safe })
    );
  } catch {
    /* ignore */
  }
}
