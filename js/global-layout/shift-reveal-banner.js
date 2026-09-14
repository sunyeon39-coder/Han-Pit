import { GL } from "./state.js";
import { getSeatConfirmHighlightState, isEmptyPerson, toMillis } from "./utils.js";

const BANNER_TEXT = "교대 5분 전 확인";

/**
 * 교대 5분 전(REVEAL) ~ 10분(SETTLE) 구간에 있는 좌석이 하나라도 있으면 "이 화면을 보고
 * 있는 모두"에게 계정과 무관하게 가벼운 배너로 알려준다. 개인 계정별 모달·백그라운드
 * 푸시와는 별개다 — 그쪽은 배치된 근무자 본인에게, 이 배너는 화면 앞에 있는 아무에게나
 * (운영자 포함) 보인다. 매초 타이머에서 호출되며, 별도 상태 없이 매번 현재 좌석 목록에서
 * 다시 계산한다. 좌석 번호는 밝히지 않고 안내 문구만 보여준다.
 */
export function updateShiftRevealBanner() {
  const el = GL.shiftRevealBanner;
  const textEl = GL.shiftRevealBannerText;
  if (!el || !textEl) return;

  const hasActive = (GL.globalSeats || []).some((s) => {
    // 스왑(교대 확정 대기 중) — 실제 occupant의 seatedAt은 안 바뀌므로 incomingAt 기준으로
    // 봐야 한다. 이걸 놓치면 스왑으로 들어온 사람의 5~10분 구간에는 배너가 영영 안 뜬다.
    if (!isEmptyPerson(String(s?.incomingPerson || "").trim())) {
      return getSeatConfirmHighlightState(toMillis(s?.incomingAt)).isBlinkPhase;
    }
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    return getSeatConfirmHighlightState(toMillis(s?.seatedAt)).isBlinkPhase;
  });

  el.hidden = !hasActive;
  el.setAttribute("aria-hidden", hasActive ? "false" : "true");
  if (hasActive) textEl.textContent = BANNER_TEXT;
}
