import { runTransaction } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const RETRYABLE = new Set(["failed-precondition", "aborted"]);

/**
 * Firestore 트랜잭션 contention·삭제된 문서 재기록 등으로
 * failed-precondition 이 나면 짧게 재시도합니다.
 */
export async function runFirestoreTransactionWithRetry(db, updateFn, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runTransaction(db, updateFn);
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || "").trim();
      if (!RETRYABLE.has(code) || attempt >= maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
  throw lastErr;
}
