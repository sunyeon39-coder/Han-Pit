import { GL } from "./state.js";

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

export function pushGlobalUndo(action, { clearRedo = true } = {}) {
  if (!action || typeof action !== "object") return;
  const stack = ensureUndoStack();
  stack.push(action);
  if (stack.length > GLOBAL_UNDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_UNDO_STACK_MAX);
  }
  if (clearRedo) clearGlobalRedoStack({ refresh: false });
  syncLastUndoCompat();
  refreshUndoToolbar();
}

export function popGlobalUndo() {
  const stack = ensureUndoStack();
  const action = stack.pop() || null;
  syncLastUndoCompat();
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
  refreshUndoToolbar();
}

export function pushGlobalRedo(action) {
  if (!action || typeof action !== "object") return;
  const stack = ensureRedoStack();
  stack.push(action);
  if (stack.length > GLOBAL_REDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_REDO_STACK_MAX);
  }
  refreshUndoToolbar();
}

export function popGlobalRedo() {
  const stack = ensureRedoStack();
  const action = stack.pop() || null;
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
  refreshUndoToolbar();
}

export function peekGlobalRedo() {
  const stack = ensureRedoStack();
  return stack.length ? stack[stack.length - 1] : null;
}

export function clearGlobalRedoStack({ refresh = true } = {}) {
  GL.globalRedoStack = [];
  if (refresh) refreshUndoToolbar();
}

export function getGlobalUndoCount() {
  return ensureUndoStack().length;
}

export function getGlobalRedoCount() {
  return ensureRedoStack().length;
}
