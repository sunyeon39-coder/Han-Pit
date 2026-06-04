import { GL } from "./state.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { getGlobalRedoCount, getGlobalUndoCount, peekGlobalRedo, peekGlobalUndo } from "./undo-stack.js";

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

function getRedoStackHint() {
  const top = peekGlobalRedo();
  const count = getGlobalRedoCount();
  if (!top || count <= 0) return "앞으로 돌릴 작업이 없습니다";
  const k = top.kind;
  if (k === "add_seat") return `되돌린 작업: Seat 추가 (남은 ${count}건) — 클릭하면 다시 적용`;
  if (k === "assign") return `되돌린 작업: 대기 → 배치 (남은 ${count}건) — 클릭하면 다시 적용`;
  if (k === "delete_seat") return `되돌린 작업: Seat 삭제 (남은 ${count}건) — 클릭하면 다시 적용`;
  if (k === "remove_waiting") return `되돌린 작업: 대기 삭제 (남은 ${count}건) — 클릭하면 다시 적용`;
  if (k === "clear_seat") return `되돌린 작업: Seat 비우기 (남은 ${count}건) — 클릭하면 다시 적용`;
  return `되돌린 작업 앞으로 (남은 ${count}건)`;
}

function applyGlobalHistoryToolbarButtons(undoBtn, redoBtn, show) {
  if (!undoBtn) return;
  const undoCount = getGlobalUndoCount();
  const redoCount = getGlobalRedoCount();
  undoBtn.disabled = !show || undoCount <= 0;
  undoBtn.textContent = "←";
  undoBtn.setAttribute(
    "aria-label",
    undoCount > 0 ? `되돌리기, 남은 ${undoCount}건` : "되돌리기"
  );
  undoBtn.title = getUndoStackHint();
  if (redoBtn) {
    redoBtn.disabled = !show || redoCount <= 0;
    redoBtn.textContent = "→";
    redoBtn.setAttribute(
      "aria-label",
      redoCount > 0 ? `앞으로돌리기, 남은 ${redoCount}건` : "앞으로돌리기"
    );
    redoBtn.title = getRedoStackHint();
  }
}

export function updateGlobalMetaToolbar() {
  const wrap = document.getElementById("globalMetaSeatActions");
  const undoBtn = document.getElementById("globalUndoToolbarBtn");
  const redoBtn = document.getElementById("globalRedoToolbarBtn");
  if (!wrap || !undoBtn) return;
  const show = GL.isAdminUser && (layoutIsMobile() ? GL.activeTab === "seat" : true);
  wrap.classList.toggle("hidden", !show);
  wrap.setAttribute("aria-hidden", show ? "false" : "true");
  applyGlobalHistoryToolbarButtons(undoBtn, redoBtn, show);
}
