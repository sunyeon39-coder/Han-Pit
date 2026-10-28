export { FCM_VAPID_KEY as VAPID_KEY } from "../shared/fcm-web-push.js";
export const ALERT_VOLUME = 0.4;
export const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

/**
 * 통합 배치도(global-layout.html) 목록형 모바일 화면 기준.
 * 일반 폰(폭 600 미만)·가로로 눕힌 폰(높이 560 미만)은 항상 목록형. 펼친 폴더블(갤럭시 폴드·아이폰 폴드)·
 * 태블릿은 운영 admin 이면 캔버스(PC 화면)로 좌석 배치·생성을 하고, 근무자(gl-view-only)는 예전처럼
 * 목록형 + 배치 알림을 유지한다. 결과를 body.gl-mobile-mode 로 반영 — css/global-layout.css 가 이 클래스로 분기.
 */
export const GL_MOBILE_MEDIA = "(max-width: 599px), (max-width: 1180px) and (max-height: 559px)";

export function layoutIsMobile() {
  const body = document.body;
  if (body?.classList.contains("page-global-layout")) {
    const mobile =
      window.matchMedia(GL_MOBILE_MEDIA).matches ||
      (body.classList.contains("gl-view-only") && window.innerWidth <= 1180);
    body.classList.toggle("gl-mobile-mode", mobile);
    return mobile;
  }
  return window.innerWidth <= 1180;
}
