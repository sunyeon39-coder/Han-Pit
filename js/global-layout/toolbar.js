import { GL } from "./state.js";
import { getGlobalUndoCount, peekGlobalUndo } from "./undo-stack.js";

export function updateTabUi() {
  GL.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === GL.activeTab));
}

function getUndoStackHint() {
  const top = peekGlobalUndo();
  const count = getGlobalUndoCount();
  if (!top || count <= 0) return "되돌릴 작업이 없습니다";
  const k = top.kind;
  if (k === "add_seat") return `최근 작업: Seat 추가 (남은 ${count}건) — 클릭하면 취소`;
  if (k === "assign") return `최근 작업: 대기 → 배치 (남은 ${count}건) — 클릭하면 취소`;
  if (k === "delete_seat") return `최근 작업: Seat 삭제 (남은 ${count}건) — 클릭하면 복구`;
  if (k === "remove_waiting") return `최근 작업: 대기 삭제 (남은 ${count}건) — 클릭하면 복구`;
  if (k === "clear_seat") return `최근 작업: Seat 비우기 (남은 ${count}건) — 클릭하면 취소`;
  return `최근 작업 되돌리기 (남은 ${count}건)`;
}

export function updateGlobalMetaToolbar() {
  const wrap = document.getElementById("globalMetaSeatActions");
  const undoBtn = document.getElementById("globalUndoToolbarBtn");
  if (!wrap || !undoBtn) return;
  const show = GL.isAdminUser && GL.activeTab === "seat";
  wrap.classList.toggle("hidden", !show);
  wrap.setAttribute("aria-hidden", show ? "false" : "true");
  const count = getGlobalUndoCount();
  undoBtn.disabled = count <= 0;
  undoBtn.textContent = count > 0 ? `되돌리기 (${count})` : "되돌리기";
  undoBtn.title = getUndoStackHint();
}
