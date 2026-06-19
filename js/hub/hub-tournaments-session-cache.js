const HUB_TOURNAMENTS_SESSION_KEY = "hanpit_hub_tournaments_v1";
const HUB_TOURNAMENTS_LOCAL_KEY = "hanpit_hub_tournaments_ls_v1";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readCacheEntry(raw, maxAgeMs) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.list) ? o.list : null;
    if (!list?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > maxAgeMs) return null;
    return list;
  } catch {
    return null;
  }
}

export function readHubTournamentsSessionCache() {
  try {
    return readCacheEntry(sessionStorage.getItem(HUB_TOURNAMENTS_SESSION_KEY), SESSION_MAX_AGE_MS);
  } catch {
    return null;
  }
}

function readHubTournamentsLocalCache() {
  try {
    return readCacheEntry(localStorage.getItem(HUB_TOURNAMENTS_LOCAL_KEY), LOCAL_MAX_AGE_MS);
  } catch {
    return null;
  }
}

/** sessionStorage → localStorage 순으로 마지막으로 확인된 대회 목록 */
export function readHubTournamentsPersistedCache() {
  return readHubTournamentsSessionCache() || readHubTournamentsLocalCache();
}

/** TTL 만료 후에도 UI 복구용 — 서버/캐시 모두 비었을 때만 */
export function readHubTournamentsLegacyCache() {
  try {
    const raw =
      localStorage.getItem(HUB_TOURNAMENTS_LOCAL_KEY) ||
      sessionStorage.getItem(HUB_TOURNAMENTS_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.list) ? o.list : null;
    return list?.length ? list : null;
  } catch {
    return null;
  }
}

export function writeHubTournamentsSessionCache(list = []) {
  const safe = Array.isArray(list) ? list : [];
  if (!safe.length) return;
  const payload = JSON.stringify({ savedAt: Date.now(), list: safe });
  try {
    sessionStorage.setItem(HUB_TOURNAMENTS_SESSION_KEY, payload);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(HUB_TOURNAMENTS_LOCAL_KEY, payload);
  } catch {
    /* ignore */
  }
}
