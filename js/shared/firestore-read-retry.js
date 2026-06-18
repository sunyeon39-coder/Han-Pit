import { ensureFirestoreOnline } from "../firebase.js";
import {
  isFirestoreQuotaCoolingDown,
  noteFirestoreQuotaExceeded
} from "./firestore-quota-guard.js";

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
 * resource-exhausted(429) 는 재시도·enableNetwork 로 한도만 악화됩니다.
 */
export async function runFirestoreReadWithRetry(readFn, options = {}) {
  if (isFirestoreQuotaCoolingDown()) {
    return readFn();
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 200;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await readFn();
    } catch (err) {
      lastErr = err;
      noteFirestoreQuotaExceeded(err);
      if (isFirestoreQuotaCoolingDown()) throw err;
      if (!isRetryableFirestoreReadError(err) || attempt >= maxAttempts - 1) throw err;
      await ensureFirestoreOnline();
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}
