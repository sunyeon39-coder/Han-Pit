import { showFirestoreStallBanner } from "../shared/firestore-stall-recovery.js";

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

// 앞 쓰기가 끝나지 않고 걸려 있으면(IndexedDB 캐시 멈춤 등) 뒤의 모든 배치·비우기가
// 영원히 줄만 서고, 화면엔 낙관적으로 반영된 채 서버엔 아무것도 안 들어간다.
// 앞 쓰기는 최대 PREV_WAIT_MS만 기다리고, 각 쓰기는 WRITE_TIMEOUT_MS 넘으면 실패로 끊는다.
const PREV_WAIT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;

function settleWithin(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("write_timeout");
      err.code = "write_timeout";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function runSerializedGlobalWaitingWrite(fn) {
  const prev = writeTail;
  const run = settleWithin(prev, PREV_WAIT_MS).then(async () => {
    writesInFlight++;
    try {
      return await withTimeout(Promise.resolve().then(fn), WRITE_TIMEOUT_MS);
    } catch (err) {
      if (err?.code === "write_timeout") {
        console.error("[global-waiting-write] write timed out", err);
        // Firestore 로컬 캐시가 멈춘 경우가 대부분 — 캐시 비우고 새로고침하는 배너를 띄운다.
        showFirestoreStallBanner("저장이 응답하지 않습니다. 연결을 새로고침해 주세요.");
      }
      throw err;
    } finally {
      writesInFlight--;
    }
  });
  writeTail = run.catch(() => {});
  return run;
}
