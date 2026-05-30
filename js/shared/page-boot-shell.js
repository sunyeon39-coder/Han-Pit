import { escapeHtml } from "./dom-utils.js";

export function showPageBootLoading(container, message = "불러오는 중…") {
  if (!container || container.dataset.pageBootLoaded === "1") return;
  container.innerHTML = `
    <div class="page-boot-loading" role="status" aria-live="polite">
      <div class="page-boot-spinner" aria-hidden="true"></div>
      <p class="page-boot-text">${escapeHtml(message)}</p>
    </div>`;
}

export function markPageBootLoaded(container) {
  if (container) container.dataset.pageBootLoaded = "1";
}
