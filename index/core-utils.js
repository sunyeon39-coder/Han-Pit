export function getTournamentId() {
  const params = new URLSearchParams(location.search);
  return (
    params.get("tournamentId") ||
    sessionStorage.getItem("tournamentId") ||
    ""
  );
}

export function ensureTournamentContextOrAlert() {
  const tournamentId = getTournamentId();
  if (tournamentId) return tournamentId;
  alert("대회 정보가 없어 허브로 이동합니다.");
  location.replace("./hub.html");
  return "";
}

export function isValidDocId(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/");
}

export function chunkArray(list = [], size = 200) {
  const safe = Array.isArray(list) ? list : [];
  const chunkSize = Math.max(1, Number(size || 1));
  const chunks = [];
  for (let i = 0; i < safe.length; i += chunkSize) {
    chunks.push(safe.slice(i, i + chunkSize));
  }
  return chunks;
}

export function sleep(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms || 0)));
  });
}

export async function commitBatchWithRetry(batch, options = {}) {
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 250));
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await batch.commit();
      return true;
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}
