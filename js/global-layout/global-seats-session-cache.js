/**
 * 통합배치도 좌석 캐시 — 마지막으로 본 좌석을 session/localStorage 에 저장해
 * 진입 즉시(인증·ops·realtime 이전) 캔버스를 그릴 수 있게 합니다. 이후 realtime 이 최신값으로 교체합니다.
 */
const SESSION_KEY_PREFIX = "hanpit_global_seats_v1_";
const LOCAL_KEY_PREFIX = "hanpit_global_seats_ls_v1_";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const LOCAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sessionKeyFor(tournamentId = "") {
  return `${SESSION_KEY_PREFIX}${String(tournamentId || "na").trim()}`;
}

function localKeyFor(tournamentId = "") {
  return `${LOCAL_KEY_PREFIX}${String(tournamentId || "na").trim()}`;
}

function readCacheEntry(raw, maxAgeMs) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.seats) ? o.seats : null;
    if (!list?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > maxAgeMs) return null;
    return list;
  } catch {
    return null;
  }
}

/** TTL 만료 후에도 Firestore 멈춤 시 UI 복구용 */
export function readGlobalSeatsLegacyCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  try {
    for (const key of [localKeyFor(id), sessionKeyFor(id)]) {
      const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (!raw) continue;
      const o = JSON.parse(raw);
      const list = Array.isArray(o?.seats) ? o.seats : null;
      if (list?.length) return list;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readGlobalSeatsCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  try {
    return (
      readCacheEntry(sessionStorage.getItem(sessionKeyFor(id)), SESSION_MAX_AGE_MS) ||
      readCacheEntry(localStorage.getItem(localKeyFor(id)), LOCAL_MAX_AGE_MS)
    );
  } catch {
    return readGlobalSeatsLegacyCache(id);
  }
}

export function writeGlobalSeatsCache(tournamentId = "", seats = []) {
  const id = String(tournamentId || "").trim();
  if (!id) return;
  const safe = Array.isArray(seats) ? seats : [];
  if (!safe.length) {
    try {
      sessionStorage.removeItem(sessionKeyFor(id));
      localStorage.removeItem(localKeyFor(id));
    } catch {
      /* ignore */
    }
    return;
  }
  const payload = JSON.stringify({ savedAt: Date.now(), seats: safe });
  try {
    sessionStorage.setItem(sessionKeyFor(id), payload);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(localKeyFor(id), payload);
  } catch {
    /* ignore */
  }
}
