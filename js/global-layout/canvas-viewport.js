import { GL } from "./state.js";

const CANVAS_ZOOM_MIN = 0.35;
const CANVAS_ZOOM_MAX = 1.85;

function storageKey() {
  return `global_layout_canvas_view_v1_${GL.tournamentId || "na"}`;
}

function clampCanvasZoom(z) {
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, z));
}

function loadCanvasViewFromStorage() {
  try {
    const raw = sessionStorage.getItem(storageKey());
    if (!raw) return;
    const o = JSON.parse(raw);
    GL.canvasPanX = Number(o.x) || 0;
    GL.canvasPanY = Number(o.y) || 0;
    GL.canvasZoom = clampCanvasZoom(Number(o.z) || 1);
  } catch {
    /* ignore */
  }
}

function saveCanvasViewToStorage() {
  try {
    sessionStorage.setItem(
      storageKey(),
      JSON.stringify({
        x: GL.canvasPanX,
        y: GL.canvasPanY,
        z: GL.canvasZoom
      })
    );
  } catch {
    /* ignore */
  }
}

function getCanvasTransformLayer(canvas) {
  return canvas?.querySelector(".canvas-inner") || canvas;
}

export function applyGlobalLayoutCanvasTransform(canvas) {
  if (!canvas) return;
  const layer = getCanvasTransformLayer(canvas);
  GL.canvasZoom = clampCanvasZoom(GL.canvasZoom || 1);
  layer.style.transform = `translate(${GL.canvasPanX}px, ${GL.canvasPanY}px) scale(${GL.canvasZoom})`;
  layer.style.transformOrigin = "center center";
  const label = GL.canvasZoomBar?.querySelector("[data-zoom-label]");
  if (label) {
    label.textContent = `${Math.round(GL.canvasZoom * 100)}%`;
  }
}

/** 헤더 `#canvasZoomBar`에 버튼 마크업을 한 번만 채웁니다. */
export function initGlobalLayoutZoomBarDom() {
  const bar = GL.canvasZoomBar || document.getElementById("canvasZoomBar");
  if (!bar) return;
  const needsMarkup =
    !bar.querySelector("[data-zoom-label]") || !bar.querySelector("[data-align-row]");
  if (needsMarkup) {
    bar.innerHTML = zoomBarHtml();
    delete bar.dataset.zoomButtonsBound;
  }
}

export function zoomBarHtml() {
  return `
      <button type="button" class="layout-canvas-zoom-btn layout-canvas-align-btn" data-align-row title="가로 한 줄 (같은 높이)">가로</button>
      <button type="button" class="layout-canvas-zoom-btn layout-canvas-align-btn" data-align-col title="세로 한 줄 (같은 좌우)">세로</button>
      <button type="button" class="layout-canvas-zoom-btn" data-zoom-out aria-label="축소">−</button>
      <span class="layout-canvas-zoom-label" data-zoom-label>100%</span>
      <button type="button" class="layout-canvas-zoom-btn" data-zoom-in aria-label="확대">+</button>
      <button type="button" class="layout-canvas-zoom-btn layout-canvas-zoom-reset" data-zoom-reset>맞춤</button>
    `;
}

export function refreshGlobalLayoutAlignButtonState() {
  const bar = GL.canvasZoomBar || document.getElementById("canvasZoomBar");
  if (!bar) return;
  const ok = GL.isAdminUser && GL.selectedSeatIds.size >= 2;
  for (const sel of ["[data-align-row]", "[data-align-col]"]) {
    const btn = bar.querySelector(sel);
    if (!btn) continue;
    btn.disabled = !ok;
    btn.setAttribute("aria-disabled", ok ? "false" : "true");
  }
}

let layoutPanSession = null;
let globalPanListenersBound = false;
let lastLoadedStorageKey = "";

function endGlobalLayoutPanSession(ev) {
  const s = layoutPanSession;
  if (!s) return;
  if (
    ev &&
    ev.type === "pointerup" &&
    typeof ev.pointerId === "number" &&
    s.pointerId != null &&
    ev.pointerId !== s.pointerId
  ) {
    return;
  }
  if (s.pointerId != null) {
    try {
      s.viewport.releasePointerCapture(s.pointerId);
    } catch {
      /* ignore */
    }
  }
  s.viewport.classList.remove("is-panning");
  layoutPanSession = null;
  saveCanvasViewToStorage();
}

function ensureGlobalPanListeners() {
  if (globalPanListenersBound) return;
  globalPanListenersBound = true;

  window.addEventListener(
    "pointermove",
    (e) => {
      const s = layoutPanSession;
      if (!s) return;
      if (s.pointerId != null && e.pointerId !== s.pointerId) return;
      GL.canvasPanX = s.ox + (e.clientX - s.sx);
      GL.canvasPanY = s.lockHorizontalOnly ? s.oy : s.oy + (e.clientY - s.sy);
      applyGlobalLayoutCanvasTransform(s.canvas);
    },
    { passive: true }
  );

  window.addEventListener("mouseup", (e) => endGlobalLayoutPanSession(e));
  window.addEventListener("pointerup", (e) => endGlobalLayoutPanSession(e));
  window.addEventListener("touchend", (e) => endGlobalLayoutPanSession(e));
}

function isPanBackgroundTarget(el, viewport, e) {
  if (!el || !el.closest) return false;
  if (el.closest(".layout-canvas-zoom-bar")) return false;
  if (el.closest(".seat-box")) {
    if (GL.panelOpen && e && e.shiftKey) return true;
    return false;
  }
  return viewport.contains(el);
}

function getGlobalLayoutCanvasEl() {
  return GL.app?.querySelector(".pc-canvas") || null;
}

function wireGlobalLayoutZoomBarOnce() {
  const bar = GL.canvasZoomBar || document.getElementById("canvasZoomBar");
  if (!bar || bar.dataset.zoomButtonsBound === "1") return;
  bar.dataset.zoomButtonsBound = "1";

  bar.querySelector("[data-zoom-out]")?.addEventListener("click", () => {
    GL.canvasZoom = clampCanvasZoom(GL.canvasZoom - 0.12);
    applyGlobalLayoutCanvasTransform(getGlobalLayoutCanvasEl());
    saveCanvasViewToStorage();
  });
  bar.querySelector("[data-zoom-in]")?.addEventListener("click", () => {
    GL.canvasZoom = clampCanvasZoom(GL.canvasZoom + 0.12);
    applyGlobalLayoutCanvasTransform(getGlobalLayoutCanvasEl());
    saveCanvasViewToStorage();
  });
  bar.querySelector("[data-zoom-reset]")?.addEventListener("click", () => {
    GL.canvasPanX = 0;
    GL.canvasPanY = 0;
    GL.canvasZoom = 1;
    applyGlobalLayoutCanvasTransform(getGlobalLayoutCanvasEl());
    saveCanvasViewToStorage();
  });

  bar.querySelector("[data-align-row]")?.addEventListener("click", async () => {
    if (!GL.isAdminUser || GL.selectedSeatIds.size < 2) return;
    const { alignSelectedGlobalSeats } = await import("./firestore-ops.js");
    await alignSelectedGlobalSeats("row");
  });
  bar.querySelector("[data-align-col]")?.addEventListener("click", async () => {
    if (!GL.isAdminUser || GL.selectedSeatIds.size < 2) return;
    const { alignSelectedGlobalSeats } = await import("./firestore-ops.js");
    await alignSelectedGlobalSeats("col");
  });

  refreshGlobalLayoutAlignButtonState();
}

export function wireGlobalLayoutCanvasViewport(viewport, canvas) {
  if (!viewport || !canvas) return;

  const key = storageKey();
  if (key !== lastLoadedStorageKey) {
    lastLoadedStorageKey = key;
    loadCanvasViewFromStorage();
  }

  initGlobalLayoutZoomBarDom();
  ensureGlobalPanListeners();
  wireGlobalLayoutZoomBarOnce();

  viewport.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!e.target || !isPanBackgroundTarget(e.target, viewport, e)) return;
      const stealSeatPan =
        GL.panelOpen &&
        e.shiftKey &&
        e.target.closest?.(".seat-box");
      if (stealSeatPan) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      layoutPanSession = {
        pointer: e.pointerType === "touch" ? "touch" : "mouse",
        viewport,
        canvas,
        sx: e.clientX,
        sy: e.clientY,
        ox: GL.canvasPanX,
        oy: GL.canvasPanY,
        lockHorizontalOnly: !!GL.panelOpen,
        pointerId: e.pointerId
      };
      viewport.classList.add("is-panning");
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    { capture: true, passive: false }
  );
}
