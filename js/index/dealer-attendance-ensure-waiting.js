/**
 * @deprecated 출근하기 없이 대기열에 자동 등록하지 않습니다.
 * (과거 ensureMyState 가 global_waiting 에 무단 추가하던 동작 제거)
 */
export async function ensureMyState() {
  return;
}
