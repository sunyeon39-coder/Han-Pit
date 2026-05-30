/**
 * Seat 캔버스 박스 DOM을 전체 innerHTML 없이 동기화 (global-layout / layout 공용)
 */
export function syncSeatBoxesInContainer(inner, seats, options) {
  const {
    getSeatId,
    getPosition,
    buildBoxState,
    escapeHtml,
    emptyMessage = "아직 생성된 전역 좌석이 없습니다."
  } = options;

  if (!inner) return { rebuilt: true };

  const sorted = [...seats].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!sorted.length) return { rebuilt: true, empty: true, emptyMessage };

  inner.querySelectorAll(".empty-panel").forEach((el) => el.remove());

  const existing = new Map();
  inner.querySelectorAll(".seat-box").forEach((box) => {
    const id = String(getSeatId(box) || "").trim();
    if (id) existing.set(id, box);
  });

  const nextIds = new Set();
  const frag = document.createDocumentFragment();

  sorted.forEach((seat, idx) => {
    const state = buildBoxState(seat, idx);
    const seatId = String(state.seatId || "").trim();
    if (!seatId) return;
    nextIds.add(seatId);

    let box = existing.get(seatId);
    if (!box) {
      box = document.createElement("div");
      frag.appendChild(box);
      existing.set(seatId, box);
    } else if (box.parentNode !== inner) {
      frag.appendChild(box);
    }

    box.className = state.className;
    box.setAttribute(state.idAttr, seatId);
    box.style.left = `${state.x}px`;
    box.style.top = `${state.y}px`;
    box.innerHTML = state.innerHtml;
  });

  existing.forEach((box, id) => {
    if (!nextIds.has(id)) box.remove();
  });

  if (frag.childNodes.length) inner.appendChild(frag);
  return { rebuilt: false };
}

export function escapeHtmlLite(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
