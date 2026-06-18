import { ensureFirestoreOnline } from "../firebase.js";

const RETRYABLE = new Set(["unavailable", "deadline-exceeded", "aborted", "internal"]);

export function isRetryableFirestoreReadError(err) {
  const code = String(err?.code || "").trim();
  return RETRYABLE.has(code);
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safari·iOS PWA에서 WebChannel/batchGet 이 unavailable 로 끊길 때
 * enableNetwork 후 짧게 재시도합니다.
 * resource-exhausted(429) 는 재시도하면 한도 초과만 악화됩니다.
 */
export async function runFirestoreReadWithRetry(readFn, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 150;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await readFn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableFirestoreReadError(err) || attempt >= maxAttempts - 1) throw err;
      await ensureFirestoreOnline();
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}
