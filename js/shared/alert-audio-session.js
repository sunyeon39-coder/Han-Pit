/**
 * 알림 비프음이 아이폰 무음(벨소리) 스위치에 막히지 않게 한다 — 화면이 켜져 있을 때만 해당.
 *
 * iOS Safari/홈 화면 웹앱(16.4+)은 기본(auto) 오디오 세션에서 Web Audio 가 무음 스위치를 따른다.
 * navigator.audioSession.type = "playback" 이면 미디어 재생처럼 취급돼 무음이어도 소리가 난다.
 * 다만 playback 은 다른 앱 음악을 멈추게 하므로 알림이 울리는 동안만 잡고, 마지막 비프 후
 * 잠시 뒤 auto 로 되돌린다. 지원하지 않는 브라우저(안드로이드 등)에서는 아무 일도 하지 않는다
 * (안드로이드는 원래 미디어 볼륨으로 나가 매너모드와 무관).
 */
const RELEASE_AFTER_MS = 2000;
let releaseTimer = 0;

export function holdAlertAudioSession(ms = RELEASE_AFTER_MS) {
  try {
    const session = typeof navigator !== "undefined" ? navigator.audioSession : null;
    if (!session || !("type" in session)) return;
    if (session.type !== "playback") session.type = "playback";
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = 0;
      try {
        session.type = "auto";
      } catch {
        /* noop */
      }
    }, Math.max(500, Number(ms) || RELEASE_AFTER_MS));
  } catch {
    /* noop */
  }
}
