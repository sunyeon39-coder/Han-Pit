/**
 * layout.html PC 캔버스: Seat 박스 DOM 생성·클릭·드래그 이동 (증분 동기화 + 이벤트 위임)
 */
import { LAYOUT_SEAT_DOUBLE_ACTIVATE_MS } from "./layout-core-utils.js";
import { syncSeatBoxesInContainer } from "../shared/sync-seat-box-dom.js";
import { seatShowsAlert } from "../shared/seat-alert.js";

export function createLayoutCanvasBuild(deps) {
  const {
    app,
    layoutViewport,
    ui,
    eventState,
    escapeHtml,
    timerClass,
    isEmptyPerson,
    canManageLayout,
    findSeat,
    assignWaitingToSeat,
    clearSeat,
    touchEvent,
    onFullRender,
    onCanvasSync,
    isSeatMine,
    EVENT_ID = "",
    BOX_ID = ""
  } = deps;

  const dragBySeatId = new Map();

  function buildLayoutSeatBoxState(seat) {
    const hasPerson = !isEmptyPerson(seat.person);
    const isSel = ui.selectedSeatId === seat.id;
    const seatedAtMs = hasPerson ? Number(seat.seatedAt || 0) : 0;
    const elapsedMs = hasPerson ? (seatedAtMs > 0 ? Date.now() - seatedAtMs : 0) : 0;
    const timerCls = hasPerson ? timerClass(elapsedMs) : "";
    const isSelf = hasPerson && !!isSeatMine?.(seat);
    const personClass = [hasPerson ? "seat-person" : "seat-person is-empty", isSelf ? "is-self" : ""]
      .filter(Boolean)
      .join(" ");
    const seatLabel = String(seat.label ?? seat.no ?? "").trim() || "—";
    return {
      seatId: String(seat.id || "").trim(),
      idAttr: "data-seatid",
      className: [
        "seat-box",
        hasPerson ? "is-occupied" : "",
        timerCls,
        isSel ? "selected" : "",
        seatShowsAlert(seat, canManageLayout?.()) ? "seat-alert-on" : ""
      ]
        .filter(Boolean)
        .join(" "),
      x: Number(seat.x || 0),
      y: Number(seat.y || 0),
      innerHtml: `
        <div class="seat-title">SEAT ${escapeHtml(seatLabel)}</div>
        <div class="${personClass}">${escapeHtml(hasPerson ? seat.person : "-")}</div>
      `
    };
  }

  /**
   * eventState.seats가 비어 있으면(layout_events / global_seats 매핑 모두 못 찾은 경우)
   * 캔버스가 아무 안내 없이 텅 비어 보였다 — 어떤 event/box를 찾고 있었는지 그대로
   * 보여줘서, 통합배치도에 등록된 좌석의 카드 ID·Box ID와 바로 비교할 수 있게 한다.
   */
  function syncCanvasEmptyState(inner, isEmpty) {
    if (!inner) return;
    const existing = inner.querySelector(".empty-panel");
    if (!isEmpty) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const msg = document.createElement("div");
    msg.className = "empty-panel";
    msg.style.cssText = "position:absolute;left:24px;top:24px;width:280px;";
    msg.textContent = `현재 이벤트(${EVENT_ID})/Box(${BOX_ID})에 등록된 Seat이 없습니다. 통합배치도에서 같은 카드·Box로 좌석을 등록했는지 확인하세요.`;
    inner.appendChild(msg);
  }

  function syncCanvasInner(inner) {
    if (!inner) return false;
    const result = syncSeatBoxesInContainer(inner, eventState.seats, {
      getSeatId: (box) => box.getAttribute("data-seatid"),
      buildBoxState: (seat) => buildLayoutSeatBoxState(seat)
    });
    syncCanvasEmptyState(inner, !!result.empty);
    return !result.rebuilt;
  }

  function syncCanvas() {
    const inner = app?.querySelector(".canvas-inner");
    if (!inner) return false;
    if (!syncCanvasInner(inner)) return false;
    const canvas = app?.querySelector(".pc-canvas");
    if (canvas) layoutViewport.applyCanvasViewportTransform(canvas);
    return true;
  }

  function dragSeatBy(seatId, dx, dy, boxEl = null) {
    if (!canManageLayout()) return;

    const seat = findSeat(seatId);
    if (!seat) return;

    const { width, height } = layoutViewport.getCanvasSize();
    const boxW = 170;
    const boxH = 90;
    const pad = 8;

    const z = Math.max(0.15, ui.canvasZoom || 1);
    const inv = 1 / z;
    seat.x = Math.max(pad, Math.min((seat.x || 0) + dx * inv, width - boxW - pad));
    seat.y = Math.max(pad, Math.min((seat.y || 0) + dy * inv, height - boxH - pad));

    eventState.updatedAt = Date.now();
    if (boxEl) {
      boxEl.style.left = `${seat.x}px`;
      boxEl.style.top = `${seat.y}px`;
      return;
    }
    if (typeof onCanvasSync === "function") onCanvasSync();
    else onFullRender();
  }

  async function handleSeatBoxClick(seatId, box) {
    const seat = findSeat(seatId);
    if (!seat) return;

    const now = Date.now();
    const occupied = !isEmptyPerson(seat.person);

    if (ui.selectedWaitingId) {
      ui.selectedSeatId = seatId;
      await assignWaitingToSeat(ui.selectedWaitingId, seatId);
      ui.selectedSeatId = null;
      ui.lastMouseClickAt = 0;
      ui.lastMouseSeatId = "";
      onFullRender();
      return;
    }

    if (occupied && canManageLayout()) {
      if (ui.lastMouseSeatId === seatId && now - ui.lastMouseClickAt < LAYOUT_SEAT_DOUBLE_ACTIVATE_MS) {
        ui.lastMouseClickAt = 0;
        ui.lastMouseSeatId = "";
        await clearSeat(seatId);
        ui.selectedSeatId = null;
        onFullRender();
        return;
      }

      ui.lastMouseClickAt = now;
      ui.lastMouseSeatId = seatId;
      ui.selectedSeatId = seatId;
      if (onCanvasSync) onCanvasSync();
      else onFullRender();
      return;
    }

    ui.lastMouseClickAt = now;
    ui.lastMouseSeatId = seatId;
    ui.selectedSeatId = seatId;
    if (onCanvasSync) onCanvasSync();
    else onFullRender();
  }

  function wireCanvasEvents() {
    if (!app || app.dataset.layoutCanvasWired === "1") return;
    app.dataset.layoutCanvasWired = "1";

    app.addEventListener("click", async (e) => {
      const box = e.target.closest(".seat-box[data-seatid]");
      if (!box) return;
      e.stopPropagation();
      const seatId = String(box.getAttribute("data-seatid") || "").trim();
      if (!seatId) return;
      await handleSeatBoxClick(seatId, box);
    });

    if (!canManageLayout()) return;

    app.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const box = e.target.closest(".seat-box[data-seatid]");
      if (!box) return;
      const seatId = String(box.getAttribute("data-seatid") || "").trim();
      if (!seatId) return;

      let startX = e.clientX;
      let startY = e.clientY;
      let moved = false;

      const onMove = (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        dragSeatBy(seatId, dx, dy, box);
        startX = clientX;
        startY = clientY;
      };

      const mm = (ev) => onMove(ev.clientX, ev.clientY);
      const mu = () => {
        window.removeEventListener("mousemove", mm);
        window.removeEventListener("mouseup", mu);
        if (moved) touchEvent(true);
      };

      window.addEventListener("mousemove", mm);
      window.addEventListener("mouseup", mu);
    });

    app.addEventListener(
      "touchstart",
      (e) => {
        const box = e.target.closest(".seat-box[data-seatid]");
        if (!box) return;
        const seatId = String(box.getAttribute("data-seatid") || "").trim();
        if (!seatId) return;
        const t = e.touches[0];
        if (!t) return;
        dragBySeatId.set(seatId, {
          box,
          startX: t.clientX,
          startY: t.clientY,
          moved: false
        });
      },
      { passive: true }
    );

    app.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (!t) return;
        for (const [seatId, st] of dragBySeatId) {
          const dx = t.clientX - st.startX;
          const dy = t.clientY - st.startY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) st.moved = true;
          if (!st.moved) continue;
          dragSeatBy(seatId, dx, dy, st.box);
          st.startX = t.clientX;
          st.startY = t.clientY;
        }
      },
      { passive: true }
    );

    app.addEventListener(
      "touchend",
      () => {
        let anyMoved = false;
        dragBySeatId.forEach((st) => {
          if (st.moved) anyMoved = true;
        });
        dragBySeatId.clear();
        if (anyMoved) touchEvent(true);
      },
      { passive: true }
    );
  }

  function buildCanvas() {
    const viewport = document.createElement("div");
    viewport.className = "layout-canvas-viewport";
    viewport.title = "빈 영역을 드래그하면 화면을 이동합니다. 상단 버튼으로 확대·축소.";

    const canvas = document.createElement("div");
    canvas.className = "pc-canvas";

    const inner = document.createElement("div");
    inner.className = "canvas-inner";

    viewport.appendChild(canvas);
    canvas.appendChild(inner);

    syncCanvasInner(inner);

    layoutViewport.bindCanvasViewport(viewport, canvas, {
      onCanvasBackgroundClick: () => {
        if (!ui.selectedWaitingId) return;
        ui.selectedWaitingId = null;
        onFullRender();
      }
    });
    layoutViewport.applyCanvasViewportTransform(canvas);
    wireCanvasEvents();

    return viewport;
  }

  return { buildCanvas, syncCanvas, wireCanvasEvents };
}
