/**
 * layout.html PC 캔버스: 헤더 줌바, 패닝, transform 적용, 뷰 상태 sessionStorage
 */
export function createLayoutCanvasViewport({ ui, app, layoutCanvasViewKey }) {
  let layoutPanSession = null;
  let layoutCanvasGlobalPanBound = false;

  const CANVAS_ZOOM_MIN = 0.35;
  const CANVAS_ZOOM_MAX = 1.85;

  function clampCanvasZoom(z) {
    return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, z));
  }

  function getLayoutCanvasTransformLayer(canvas) {
    return canvas?.querySelector(".canvas-inner") || canvas;
  }

  function getLayoutZoomBarEl() {
    return document.getElementById("canvasZoomBar");
  }

  function getLayoutCanvasEl() {
    return app?.querySelector(".pc-canvas") || null;
  }

  function getCanvasSize() {
    const rect = app.getBoundingClientRect();
    return {
      width: Math.max(320, Math.floor(rect.width || window.innerWidth || 1200)),
      height: Math.max(420, Math.floor(rect.height || (window.innerHeight - 64) || 700))
    };
  }

  function loadCanvasViewFromStorage() {
    try {
      const raw = sessionStorage.getItem(layoutCanvasViewKey);
      if (!raw) return;
      const o = JSON.parse(raw);
      ui.canvasPanX = Number(o.x) || 0;
      ui.canvasPanY = Number(o.y) || 0;
      ui.canvasZoom = clampCanvasZoom(Number(o.z) || 1);
    } catch {
      /* ignore */
    }
  }

  function saveCanvasViewToStorage() {
    try {
      sessionStorage.setItem(
        layoutCanvasViewKey,
        JSON.stringify({
          x: ui.canvasPanX,
          y: ui.canvasPanY,
          z: ui.canvasZoom
        })
      );
    } catch {
      /* ignore */
    }
  }

  function initLayoutZoomBarDom() {
    const bar = getLayoutZoomBarEl();
    if (!bar || bar.querySelector("[data-zoom-label]")) return;
    bar.innerHTML = `
      <button type="button" class="layout-canvas-zoom-btn" data-zoom-out aria-label="축소">−</button>
      <span class="layout-canvas-zoom-label" data-zoom-label>100%</span>
      <button type="button" class="layout-canvas-zoom-btn" data-zoom-in aria-label="확대">+</button>
      <button type="button" class="layout-canvas-zoom-btn layout-canvas-zoom-reset" data-zoom-reset>맞춤</button>
    `;
  }

  function applyCanvasViewportTransform(canvas) {
    const cv = canvas || getLayoutCanvasEl();
    if (!cv) return;
    const layer = getLayoutCanvasTransformLayer(cv);
    ui.canvasZoom = clampCanvasZoom(ui.canvasZoom || 1);
    layer.style.transform = `translate(${ui.canvasPanX}px, ${ui.canvasPanY}px) scale(${ui.canvasZoom})`;
    layer.style.transformOrigin = "center center";
    const label = getLayoutZoomBarEl()?.querySelector("[data-zoom-label]");
    if (label) {
      label.textContent = `${Math.round(ui.canvasZoom * 100)}%`;
    }
  }

  function ensureLayoutCanvasGlobalPanListeners() {
    if (layoutCanvasGlobalPanBound) return;
    layoutCanvasGlobalPanBound = true;

    window.addEventListener("mousemove", (e) => {
      const s = layoutPanSession;
      if (!s || s.pointer !== "mouse") return;
      ui.canvasPanX = s.ox + (e.clientX - s.sx);
      ui.canvasPanY = s.oy + (e.clientY - s.sy);
      applyCanvasViewportTransform(s.canvas);
    });

    window.addEventListener("mouseup", () => {
      const s = layoutPanSession;
      if (!s || s.pointer !== "mouse") return;
      s.viewport.classList.remove("is-panning");
      layoutPanSession = null;
      saveCanvasViewToStorage();
    });

    window.addEventListener(
      "touchmove",
      (e) => {
        const s = layoutPanSession;
        if (!s || s.pointer !== "touch") return;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (!t) return;
        ui.canvasPanX = s.ox + (t.clientX - s.sx);
        ui.canvasPanY = s.oy + (t.clientY - s.sy);
        applyCanvasViewportTransform(s.canvas);
      },
      { passive: true }
    );

    window.addEventListener("touchend", () => {
      const s = layoutPanSession;
      if (!s || s.pointer !== "touch") return;
      s.viewport.classList.remove("is-panning");
      layoutPanSession = null;
      saveCanvasViewToStorage();
    });
  }

  function wireLayoutZoomBarOnce() {
    const bar = getLayoutZoomBarEl();
    if (!bar || bar.dataset.zoomButtonsBound === "1") return;
    bar.dataset.zoomButtonsBound = "1";

    bar.querySelector("[data-zoom-out]")?.addEventListener("click", () => {
      ui.canvasZoom = clampCanvasZoom(ui.canvasZoom - 0.12);
      applyCanvasViewportTransform();
      saveCanvasViewToStorage();
    });
    bar.querySelector("[data-zoom-in]")?.addEventListener("click", () => {
      ui.canvasZoom = clampCanvasZoom(ui.canvasZoom + 0.12);
      applyCanvasViewportTransform();
      saveCanvasViewToStorage();
    });
    bar.querySelector("[data-zoom-reset]")?.addEventListener("click", () => {
      ui.canvasPanX = 0;
      ui.canvasPanY = 0;
      ui.canvasZoom = 1;
      applyCanvasViewportTransform();
      saveCanvasViewToStorage();
    });
  }

  function bindCanvasViewport(viewport, canvas) {
    ensureLayoutCanvasGlobalPanListeners();
    initLayoutZoomBarDom();
    wireLayoutZoomBarOnce();

    function isPanBackgroundTarget(el) {
      if (!el || !el.closest) return false;
      if (el.closest("#canvasZoomBar")) return false;
      if (el.closest(".seat-box")) return false;
      return viewport.contains(el);
    }

    viewport.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (!isPanBackgroundTarget(e.target)) return;
      layoutPanSession = {
        pointer: "mouse",
        viewport,
        canvas,
        sx: e.clientX,
        sy: e.clientY,
        ox: ui.canvasPanX,
        oy: ui.canvasPanY
      };
      viewport.classList.add("is-panning");
    });

    viewport.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        if (!isPanBackgroundTarget(e.target)) return;
        const t = e.touches[0];
        if (!t) return;
        layoutPanSession = {
          pointer: "touch",
          viewport,
          canvas,
          sx: t.clientX,
          sy: t.clientY,
          ox: ui.canvasPanX,
          oy: ui.canvasPanY
        };
        viewport.classList.add("is-panning");
      },
      { passive: true }
    );
  }

  return {
    getCanvasSize,
    loadCanvasViewFromStorage,
    getLayoutCanvasEl,
    applyCanvasViewportTransform,
    bindCanvasViewport
  };
}
