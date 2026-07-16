/** layout_shared/global_waiting 단일 문서 — 클라이언트 내 Firestore 쓰기 직렬화 */
let writeTail = Promise.resolve();
let writesInFlight = 0;

export function isGlobalWaitingWriteInFlight() {
  return writesInFlight > 0;
}

export function runSerializedGlobalWaitingWrite(fn) {
  const run = writeTail.then(async () => {
    writesInFlight++;
    try {
      return await fn();
    } finally {
      writesInFlight--;
    }
  });
  writeTail = run.catch(() => {});
  return run;
}
