import { GL } from "./state.js";

const GLOBAL_UNDO_STACK_MAX = 20;

function ensureUndoStack() {
  if (!Array.isArray(GL.globalUndoStack)) GL.globalUndoStack = [];
  return GL.globalUndoStack;
}

function syncLastUndoCompat() {
  const stack = ensureUndoStack();
  GL.lastGlobalUndo = stack.length ? stack[stack.length - 1] : null;
}

export function pushGlobalUndo(action) {
  if (!action || typeof action !== "object") return;
  const stack = ensureUndoStack();
  stack.push(action);
  if (stack.length > GLOBAL_UNDO_STACK_MAX) {
    stack.splice(0, stack.length - GLOBAL_UNDO_STACK_MAX);
  }
  syncLastUndoCompat();
}

export function popGlobalUndo() {
  const stack = ensureUndoStack();
  const action = stack.pop() || null;
  syncLastUndoCompat();
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
}

export function peekGlobalUndo() {
  const stack = ensureUndoStack();
  return stack.length ? stack[stack.length - 1] : null;
}

export function clearGlobalUndoStack() {
  GL.globalUndoStack = [];
  GL.lastGlobalUndo = null;
}

export function getGlobalUndoCount() {
  return ensureUndoStack().length;
}
