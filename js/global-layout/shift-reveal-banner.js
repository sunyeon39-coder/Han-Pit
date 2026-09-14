import { GL } from "./state.js";
import {
  getSeatConfirmHighlightState,
  isEmptyPerson,
  seatCanvasDigitsOnly,
  toMillis
} from "./utils.js";

const MAX_LISTED_SEATS = 3;

/**
 * 교대 5분 전(REVEAL) ~ 10분(SETTLE) 구간에 있는 좌석을 "이 화면을 보고 있는 모두"에게
 * 계정과 무관하게 가벼운 배너로 알려준다. 개인 계정별 모달·백그라운드 푸시와는 별개다 —
 * 그쪽은 배치된 근무자 본인에게, 이 배너는 화면 앞에 있는 아무에게나(운영자 포함) 보인다.
 * 매초 타이머에서 호출되며, 별도 상태 없이 매번 현재 좌석 목록에서 다시 계산한다.
 */
export function updateShiftRevealBanner() {
  const el = GL.shiftRevealBanner;
  const textEl = GL.shiftRevealBannerText;
  if (!el || !textEl) return;

  const active = (GL.globalSeats || []).filter((s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    return getSeatConfirmHighlightState(toMillis(s?.seatedAt)).isBlinkPhase;
  });

  document.body.classList.toggle("has-shift-banner", active.length > 0);
  el.hidden = active.length === 0;
  el.setAttribute("aria-hidden", active.length === 0 ? "true" : "false");
  if (!active.length) return;

  const labels = active
    .map((s) => seatCanvasDigitsOnly(s.label, s.no))
    .filter(Boolean);

  textEl.textContent =
    labels.length <= MAX_LISTED_SEATS
      ? `SEAT ${labels.join(", ")} 교대 5분 전 확인`
      : `${labels.length}개 좌석 교대 5분 전 확인`;
}
