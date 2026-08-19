/** global_waiting 관련 문서들 — 클라이언트 내 Firestore 쓰기 직렬화 */
let writeTail = Promise.resolve();
let writesInFlight = 0;
let blockSavePending = false;

export function isGlobalWaitingWriteInFlight() {
  return writesInFlight > 0;
}

export function isWaitingBlockSavePending() {
  return blockSavePending;
}

export function setWaitingBlockSavePending(next = false) {
  blockSavePending = next === true;
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
