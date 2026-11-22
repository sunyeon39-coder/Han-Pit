/**
 * 알림 비프음이 아이폰 무음(벨소리) 스위치에 막히지 않게 한다 — 화면이 켜져 있을 때만 해당.
 *
 * iOS 에서 Web Audio(AudioContext 로 만든 비프)는 무음 스위치를 따르지만, HTML <audio> 미디어
 * 재생은 무음 스위치와 무관하게 소리가 난다(무음이어도 Safari 동영상 소리가 나는 것과 같은 원리).
 * 그래서 iOS 에서는 비프를 WAV 로 만들어 <audio> 로 재생한다.
 *  - iOS 자동재생 제한: 처음 화면을 터치할 때 각 소리 요소를 한 번 무음으로 재생해 "잠금 해제"해 두면,
 *    이후에는 코드에서 바로 play() 할 수 있다.
 *  - navigator.audioSession(iOS 16.4+/17)이 있으면 울리는 동안만 "playback" 으로 잡았다가 되돌린다.
 * 안드로이드·PC 는 기존 Web Audio 비프를 그대로 쓴다(안드로이드는 원래 미디어 볼륨으로 나가 매너모드와 무관).
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

export function isIosLike() {
  try {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  } catch {
    return false;
  }
}

/**
 * 톤 정의 — 휴대폰 스피커가 가장 크게 내는 2~2.6kHz 대역의 사각파를, 감쇠 없이 최대 음량으로
 * 짧게 여러 번 끊어 울린다(처음 버전은 880~1kHz 삼각파 + 빠른 감쇠라 실제로 작게 들렸다).
 * pulses: [주파수(Hz), 길이(초), 다음 펄스까지 쉼(초)]
 */
const TONES = {
  call: [[2600, 0.16, 0.06], [2000, 0.16, 0.06], [2600, 0.16, 0.06], [2000, 0.22, 0]],
  seat: [[2300, 0.18, 0.07], [2300, 0.18, 0.07], [2300, 0.24, 0]],
  alert: [[2800, 0.14, 0.05], [2800, 0.14, 0.05], [2800, 0.14, 0]]
};

/** 16-bit mono PCM WAV → Blob URL */
function buildToneUrl(pulses) {
  const rate = 22050;
  const AMP = 0.97;
  const parts = pulses.map(([freq, dur, gap]) => ({ freq, n: Math.floor(rate * dur), gapN: Math.floor(rate * gap) }));
  const total = parts.reduce((acc, p) => acc + p.n + p.gapN, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + total * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, total * 2, true);
  let o = 44;
  const attack = Math.floor(rate * 0.004);
  const release = Math.floor(rate * 0.012);
  for (const { freq, n, gapN } of parts) {
    for (let i = 0; i < n; i += 1) {
      // 딸깍 소리만 막는 아주 짧은 어택/릴리즈, 나머지는 최대 음량 유지
      const env = Math.min(1, i / attack, (n - i) / release);
      const phase = (freq * i) / rate;
      const sq = phase - Math.floor(phase) < 0.5 ? 1 : -1;
      v.setInt16(o, Math.round(sq * env * AMP * 32767), true);
      o += 2;
    }
    for (let i = 0; i < gapN; i += 1) {
      v.setInt16(o, 0, true);
      o += 2;
    }
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

const mediaEls = new Map();
let unlocked = false;

function ensureMediaEls() {
  if (mediaEls.size) return;
  for (const [name, pulses] of Object.entries(TONES)) {
    const el = new Audio();
    el.preload = "auto";
    el.volume = 1;
    el.src = buildToneUrl(pulses);
    el.setAttribute("playsinline", "");
    mediaEls.set(name, el);
  }
}

/** 첫 터치 때 각 소리를 무음으로 한 번 재생해 iOS 자동재생 제한을 풀어 둔다 */
function unlockOnGesture() {
  if (unlocked) return;
  unlocked = true;
  try {
    ensureMediaEls();
    for (const el of mediaEls.values()) {
      el.muted = true;
      const p = el.play();
      const reset = () => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      };
      if (p && typeof p.then === "function") p.then(reset, () => {
        el.muted = false;
        unlocked = false; // 실패하면 다음 터치에 다시 시도
      });
      else reset();
    }
  } catch {
    unlocked = false;
  }
}

if (typeof window !== "undefined" && isIosLike()) {
  for (const evt of ["touchend", "click", "keydown"]) {
    window.addEventListener(evt, unlockOnGesture, { capture: true, passive: true });
  }
}

/**
 * iOS 면 무음 스위치를 무시하는 <audio> 로 비프를 재생하고 true 를 돌려준다.
 * iOS 가 아니거나 아직 화면 터치(잠금 해제) 전이면 false — 호출측이 기존 Web Audio 비프를 쓴다.
 */
export function playIosMediaBeep(kind = "seat") {
  if (!isIosLike() || !unlocked) return false;
  const el = mediaEls.get(kind) || mediaEls.get("seat");
  if (!el) return false;
  try {
    holdAlertAudioSession();
    el.muted = false;
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
