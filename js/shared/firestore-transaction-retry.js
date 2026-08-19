import { runTransaction } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const RETRYABLE = new Set(["failed-precondition", "aborted"]);
// global_waiting_meta/operatorPicks 처럼 여러 운영자가 동시에 같은 문서를 트랜잭션으로
// 건드리는 "핫 도큐먼트"는 순간적으로 몰리면 resource-exhausted 가 날 수 있다 —
// 이건 진짜 조합 오류가 아니라 "잠깐 몰렸으니 조금 쉬었다 다시" 신호라, contention
// 재시도보다 더 길게 기다렸다가 재시도한다.
const QUOTA_RETRYABLE = new Set(["resource-exhausted"]);

/**
 * Firestore 트랜잭션 contention·삭제된 문서 재기록 등으로
 * failed-precondition 이 나면 짧게 재시도합니다.
 */
export async function runFirestoreTransactionWithRetry(db, updateFn, maxAttempts = 6) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runTransaction(db, updateFn);
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || "").trim();
      const isQuota = QUOTA_RETRYABLE.has(code);
      if ((!RETRYABLE.has(code) && !isQuota) || attempt >= maxAttempts - 1) throw err;
      const delayMs = isQuota ? Math.min(3000, 800 * 2 ** attempt) : Math.min(1200, 80 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
