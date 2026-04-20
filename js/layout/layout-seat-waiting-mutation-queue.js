/**
 * layout: 좌석/대기 뮤테이션 직렬화 + heal 후처리 큐 (다음 뮤테이션이 heal 완료까지 막히지 않게 분리)
 */
export function createSeatWaitingMutationQueue() {
  let seatWaitingMutationChain = Promise.resolve();
  let layoutHealEnqueueChain = Promise.resolve();

  function enqueueHealAfterMutation(work) {
    layoutHealEnqueueChain = layoutHealEnqueueChain
      .then(() => work())
      .catch((err) => {
        console.error("layout heal enqueue error:", err);
      });
  }

  function runSeatWaitingMutationSerialized(fn) {
    const out = seatWaitingMutationChain.then(() => fn());
    seatWaitingMutationChain = out.catch((err) => {
      console.error("layout seat/waiting serialized mutation error:", err);
    });
    return out;
  }

  return { runSeatWaitingMutationSerialized, enqueueHealAfterMutation };
}
