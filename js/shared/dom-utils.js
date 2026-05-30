export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 모달을 Firestore/렌더 완료 전에 즉시 표시 */
export function openModal(el) {
  if (!el) return;
  if (el.classList.contains("show")) return;
  el.classList.add("show");
  void el.offsetHeight;
}

export function closeModal(el) {
  el?.classList.remove("show");
}
