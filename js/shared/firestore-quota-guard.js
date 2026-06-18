/** resource-exhausted(429) 감지 시 잠시 Firestore 읽기·resync 를 멈춤 */
const COOLDOWN_MS = 120_000;
let quotaUntil = 0;

export function isFirestoreQuotaCoolingDown() {
  return Date.now() < quotaUntil;
}

export function noteFirestoreQuotaExceeded(err) {
  const code = String(err?.code || "").trim();
  if (code !== "resource-exhausted") return;
  quotaUntil = Math.max(quotaUntil, Date.now() + COOLDOWN_MS);
}

export function remainingQuotaCooldownMs() {
  return Math.max(0, quotaUntil - Date.now());
}
