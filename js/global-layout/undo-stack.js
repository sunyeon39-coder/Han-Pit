import { GL } from "./state.js";
import { writeGlobalUndoSessionCache, readGlobalUndoSessionCache } from "./global-undo-session-cache.js";

const GLOBAL_UNDO_STACK_MAX = 20;
const GLOBAL_REDO_STACK_MAX = 20;

function ensureUndoStack() {
  if (!Array.isArray(GL.globalUndoStack)) GL.globalUndoStack = [];
  return GL.globalUndoStack;
}

function ensureRedoStack() {
  if (!Array.isArray(GL.globalRedoStack)) GL.globalRedoStack = [];
  return GL.globalRedoStack;
}

function syncLastUndoCompat() {
  const stack = ensureUndoStack();
  GL.lastGlobalUndo = stack.length ? stack[stack.length - 1] : null;
}

function refreshUndoToolbar() {
  void import("./toolbar.js")
    .then((m) => m.updateGlobalMetaToolbar())
    .catch(() => {});
}

/** 현재 undo/redo 스택을 sessionStorage 에 반영 — index.html 등으로 이동했다 돌아와도 유지되도록 */
function persistUndoSession() {
  writeGlobalUndoSessionCache(GL.tournamentId, ensureUndoStack(), ensureRedoStack());
}

/**
 * 페이지 진입 시(startGlobalLayoutApp) 호출 — sessionStorage 에 저장된 되돌리기 기록이
 * 있으면 복원한다. GL.tournamentId 가 세팅된 뒤(initGlFromUrl 이후)에 호출해야 한다.
 */
export function restoreGlobalUndoStackFromSession() {
  const cached = readGlobalUndoSessionCache(GL.tournamentId);
  if (!cached) return;
  GL.globalUndoStack = Array.isArray(cached.undo) ? cached.undo.slice(-GLOBAL_UNDO_STACK_MAX) : [];
  GL.globalRedoStack = Array.isArray(cached.redo) ? cached.redo.slice(-GLOBAL_REDO_STACK_MAX) : [];
  syncLastUndoCompat();
  refreshUndoToolbar();
}

export function pushGlobalUndo(action, { clearRedo = true } = {}) {
  if (!action || typeof action !== "object") return;
  const stack = ensureUndoStack();
  stack.push(action);
  if (stack.length > GLOBAL_UNDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_UNDO_STACK_MAX);
  }
  if (clearRedo) clearGlobalRedoStack({ refresh: false });
  syncLastUndoCompat();
  persistUndoSession();
  refreshUndoToolbar();
}

export function popGlobalUndo() {
  const stack = ensureUndoStack();
  const action = stack.pop() || null;
  syncLastUndoCompat();
  persistUndoSession();
  refreshUndoToolbar();
  return action;
}

export function restoreGlobalUndo(action) {
  if (!action || typeof action !== "object") return;
  const stack = ensureUndoStack();
  stack.push(action);
  if (stack.length > GLOBAL_UNDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_UNDO_STACK_MAX);
  }
  syncLastUndoCompat();
  persistUndoSession();
  refreshUndoToolbar();
}

export function peekGlobalUndo() {
  const stack = ensureUndoStack();
  return stack.length ? stack[stack.length - 1] : null;
}

export function clearGlobalUndoStack() {
  GL.globalUndoStack = [];
  GL.lastGlobalUndo = null;
  clearGlobalRedoStack({ refresh: false });
  persistUndoSession();
  refreshUndoToolbar();
}

export function pushGlobalRedo(action) {
  if (!action || typeof action !== "object") return;
  const stack = ensureRedoStack();
  stack.push(action);
  if (stack.length > GLOBAL_REDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_REDO_STACK_MAX);
  }
  persistUndoSession();
  refreshUndoToolbar();
}

export function popGlobalRedo() {
  const stack = ensureRedoStack();
  const action = stack.pop() || null;
  persistUndoSession();
  refreshUndoToolbar();
  return action;
}

export function restoreGlobalRedo(action) {
  if (!action || typeof action !== "object") return;
  const stack = ensureRedoStack();
  stack.push(action);
  if (stack.length > GLOBAL_REDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_REDO_STACK_MAX);
  }
  persistUndoSession();
  refreshUndoToolbar();
}

export function peekGlobalRedo() {
  const stack = ensureRedoStack();
  return stack.length ? stack[stack.length - 1] : null;
}

export function clearGlobalRedoStack({ refresh = true } = {}) {
  GL.globalRedoStack = [];
  persistUndoSession();
  if (refresh) refreshUndoToolbar();
}

export function getGlobalUndoCount() {
  return ensureUndoStack().length;
}

export function getGlobalRedoCount() {
  return ensureRedoStack().length;
}
