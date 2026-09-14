export { FCM_VAPID_KEY as VAPID_KEY } from "../shared/fcm-web-push.js";
export const ALERT_VOLUME = 0.4;
export const SOUND_ENABLED_KEY = "boxboard_sound_enabled_v1";

export function layoutIsMobile() {
  return window.innerWidth <= 1180;
}
