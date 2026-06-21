/**
 * 통합배치도 좌석 캐시 — 마지막으로 본 좌석을 sessionStorage 에 저장해
 * 진입 즉시(인증·ops·realtime 이전) 캔버스를 그릴 수 있게 합니다. 이후 realtime 이 최신값으로 교체합니다.
 */
const KEY_PREFIX = "hanpit_global_seats_v1_";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function keyFor(tournamentId = "") {
  return `${KEY_PREFIX}${String(tournamentId || "na").trim()}`;
}

export function readGlobalSeatsCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(keyFor(id));
    if (!raw) return null;
    const o = JSON.parse(raw);
    const list = Array.isArray(o?.seats) ? o.seats : null;
    if (!list?.length) return null;
    const age = Date.now() - Number(o.savedAt || 0);
    if (age < 0 || age > MAX_AGE_MS) return null;
    return list;
  } catch {
    return null;
  }
}

export function writeGlobalSeatsCache(tournamentId = "", seats = []) {
  const id = String(tournamentId || "").trim();
  if (!id) return;
  const safe = Array.isArray(seats) ? seats : [];
  try {
    if (!safe.length) {
      sessionStorage.removeItem(keyFor(id));
      return;
    }
    sessionStorage.setItem(keyFor(id), JSON.stringify({ savedAt: Date.now(), seats: safe }));
  } catch {
    /* ignore */
  }
}
