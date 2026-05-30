const HUB_TOURNAMENTS_SESSION_KEY = "hanpit_hub_tournaments_v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function readHubTournamentsSessionCache() {
  try {
    const raw = sessionStorage.getItem(HUB_TOURNAMENTS_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.list) ? o.list : null;
    if (!list?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > MAX_AGE_MS) return null;
    return list;
  } catch {
    return null;
  }
}

export function writeHubTournamentsSessionCache(list = []) {
  const safe = Array.isArray(list) ? list : [];
  if (!safe.length) return;
  try {
    sessionStorage.setItem(
      HUB_TOURNAMENTS_SESSION_KEY,
      JSON.stringify({ savedAt: Date.now(), list: safe })
    );
  } catch {
    /* ignore */
  }
}
