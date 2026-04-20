import { GL } from "./state.js";

export function updateTabUi() {
  GL.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === GL.activeTab));
}

function getUndoStackHint() {
  if (!GL.lastGlobalUndo) return "되돌릴 작업이 없습니다";
  const k = GL.lastGlobalUndo.kind;
  if (k === "add_seat") return "마지막 작업: Seat 추가 — 클릭하면 취소";
  if (k === "assign") return "마지막 작업: 대기 → 배치 — 클릭하면 취소";
  if (k === "delete_seat") return "마지막 작업: Seat 삭제 — 클릭하면 복구";
  if (k === "remove_waiting") return "마지막 작업: 대기 삭제 — 클릭하면 복구";
  return "마지막 작업 되돌리기";
}

export function updateGlobalMetaToolbar() {
  const wrap = document.getElementById("globalMetaSeatActions");
  const undoBtn = document.getElementById("globalUndoToolbarBtn");
  if (!wrap || !undoBtn) return;
  const show = GL.isAdminUser && GL.activeTab === "seat";
  wrap.classList.toggle("hidden", !show);
  wrap.setAttribute("aria-hidden", show ? "false" : "true");
  undoBtn.disabled = !GL.lastGlobalUndo;
  undoBtn.title = getUndoStackHint();
}
