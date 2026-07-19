/**
 * 통합배치도 되돌리기(undo/redo) 스택을 sessionStorage 에 저장합니다.
 * GL.globalUndoStack/globalRedoStack 은 원래 메모리(모듈 변수)에만 있어서,
 * index.html 등 다른 페이지로 이동했다가 다시 통합배치도로 돌아오면(뒤로가기 포함)
 * 페이지가 완전히 새로 로드되며 기록이 사라졌다 — 여기서 탭이 살아있는 동안만
 * 유지되는 sessionStorage 에 대회별로 저장해 이동 후에도 되돌리기가 가능하게 한다.
 */
const SESSION_KEY_PREFIX = "hanpit_global_undo_v1_";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function sessionKeyFor(tournamentId = "") {
  return `${SESSION_KEY_PREFIX}${String(tournamentId || "na").trim()}`;
}

/** Firestore Timestamp 인스턴스가 섞여 있어도 JSON 저장이 깨지지 않도록 millis 로 변환 */
function timestampSafeReplacer(_key, value) {
  if (value && typeof value === "object" && typeof value.toMillis === "function") {
    try {
      return value.toMillis();
    } catch {
      return null;
    }
  }
  return value;
}

export function readGlobalUndoSessionCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  try {
    const raw = sessionStorage.getItem(sessionKeyFor(id));
    if (!raw) return null;
    const o = JSON.parse(raw);
    const age = Date.now() - Number(o?.savedAt || 0);
    if (age < 0 || age > MAX_AGE_MS) return null;
    const undo = Array.isArray(o?.undo) ? o.undo : [];
    const redo = Array.isArray(o?.redo) ? o.redo : [];
    if (!undo.length && !redo.length) return null;
    return { undo, redo };
  } catch {
    return null;
  }
}

export function writeGlobalUndoSessionCache(tournamentId = "", undo = [], redo = []) {
  const id = String(tournamentId || "").trim();
  if (!id) return;
  const safeUndo = Array.isArray(undo) ? undo : [];
  const safeRedo = Array.isArray(redo) ? redo : [];

  if (!safeUndo.length && !safeRedo.length) {
    try {
      sessionStorage.removeItem(sessionKeyFor(id));
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    const payload = JSON.stringify(
      { savedAt: Date.now(), undo: safeUndo, redo: safeRedo },
      timestampSafeReplacer
    );
    sessionStorage.setItem(sessionKeyFor(id), payload);
  } catch {
    // 저장 용량 초과 등으로 실패해도 현재 세션의 되돌리기 동작 자체에는 영향 없음 —
    // 다음 페이지 이동 시 되돌리기 기록만 유지되지 못할 뿐이라 조용히 무시한다.
  }
}

export function clearGlobalUndoSessionCache(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return;
  try {
    sessionStorage.removeItem(sessionKeyFor(id));
  } catch {
    /* ignore */
  }
}
