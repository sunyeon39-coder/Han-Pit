/**
 * 화면 상단 짧은 안내(토스트) — 저장 진행/완료처럼 확인용 알림. 같은 id로 다시 부르면
 * 내용만 바뀐다("저장 중…" → "완료" 전환용).
 */
const TOAST_ID = "hanpitToast";
let hideTimer = null;

export function showToast(message = "", { tone = "ok", durationMs = 2600 } = {}) {
  if (typeof document === "undefined") return;
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOAST_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText =
      "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;" +
      "max-width:calc(100vw - 32px);padding:12px 18px;border-radius:10px;" +
      "font-size:15px;font-weight:700;line-height:1.4;text-align:center;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.45);pointer-events:none;transition:opacity .2s;";
    document.body.appendChild(el);
  }
  const palette = {
    ok: ["#1f6f43", "#fff", "#2f9a5d"],
    busy: ["#1f2430", "#fff", "#3a4252"],
    warn: ["#7a3b12", "#fff", "#b0581c"]
  };
  const [bg, fg, border] = palette[tone] || palette.ok;
  el.style.background = bg;
  el.style.color = fg;
  el.style.border = `1px solid ${border}`;
  el.textContent = message;
  el.style.opacity = "1";
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (durationMs > 0) {
    hideTimer = setTimeout(() => {
      el.style.opacity = "0";
      hideTimer = null;
    }, durationMs);
  }
}
