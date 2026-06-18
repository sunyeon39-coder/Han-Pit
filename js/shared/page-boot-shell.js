import { escapeHtml } from "./dom-utils.js";

export const PAGE_SHELL_BG = "#060c17";

/** 외부 CSS 로드 전에도 흰 화면(FOUC) 방지 */
export function ensureDocumentShellBackground() {
  const root = document.documentElement;
  const body = document.body;
  if (root) {
    root.style.backgroundColor = PAGE_SHELL_BG;
    root.style.colorScheme = "dark";
  }
  if (body) body.style.backgroundColor = PAGE_SHELL_BG;
}

export function showPageBootLoading(container, message = "불러오는 중…") {
  if (!container || container.dataset.pageBootLoaded === "1") return;
  ensureDocumentShellBackground();
  container.innerHTML = `
    <div class="page-boot-loading page-boot-loading--fullscreen" role="status" aria-live="polite">
      <div class="page-boot-spinner" aria-hidden="true"></div>
      <p class="page-boot-text">${escapeHtml(message)}</p>
    </div>`;
}

export function dismissPageBootLoading(container) {
  if (!container) return;
  container.querySelector(".page-boot-loading")?.remove();
}

export function markPageBootLoaded(container) {
  if (!container) return;
  container.dataset.pageBootLoaded = "1";
  dismissPageBootLoading(container);
}

/** HTML 인라인 스피너·page-boot-loading 을 JS 로드 직후 즉시 제거 */
export function instantDismissAllBootLoaders() {
  ensureDocumentShellBackground();
  document.querySelectorAll(".page-boot-loading").forEach((el) => el.remove());
  for (const id of ["indexRoot", "eventList", "app", "globalLayoutApp"]) {
    const el = document.getElementById(id);
    if (el) markPageBootLoaded(el);
  }
}
