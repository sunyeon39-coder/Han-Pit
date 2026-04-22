/**
 * layout.html PC 캔버스: Seat 박스 DOM 생성·클릭·드래그 이동
 */
import { LAYOUT_SEAT_DOUBLE_ACTIVATE_MS } from "./layout-core-utils.js";

export function createLayoutCanvasBuild(deps) {
  const {
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
    getCurrentUserUid
  } = deps;

  function dragSeatBy(seatId, dx, dy) {
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
    onFullRender();
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

    eventState.seats.forEach((seat) => {
      const box = document.createElement("div");
      const hasPerson = !isEmptyPerson(seat.person);
      const isSel = ui.selectedSeatId === seat.id;
      const seatedAtMs = hasPerson ? Number(seat.seatedAt || 0) : 0;
      const elapsedMs = hasPerson ? (seatedAtMs > 0 ? Date.now() - seatedAtMs : 0) : 0;
      const timerCls = hasPerson ? timerClass(elapsedMs) : "";
      box.className = ["seat-box", hasPerson ? "is-occupied" : "", timerCls, isSel ? "selected" : ""]
        .filter(Boolean)
        .join(" ");
      box.dataset.seatid = seat.id;
      box.style.left = `${seat.x || 0}px`;
      box.style.top = `${seat.y || 0}px`;
      const myUid = String(getCurrentUserUid?.() || "").trim();
      const seatUid = String(seat.personUid || "").trim();
      const isSelf = hasPerson && myUid && seatUid === myUid;
      const personClass = [hasPerson ? "seat-person" : "seat-person is-empty", isSelf ? "is-self" : ""]
        .filter(Boolean)
        .join(" ");
      const seatLabel = String(seat.label ?? seat.no ?? "").trim() || "—";
      box.innerHTML = `
        <div class="seat-title">SEAT ${escapeHtml(seatLabel)}</div>
        <div class="${personClass}">${escapeHtml(hasPerson ? seat.person : "-")}</div>
      `;
      inner.appendChild(box);

      box.addEventListener("click", async (e) => {
        e.stopPropagation();

        const now = Date.now();
        const occupied = !isEmptyPerson(seat.person);

        if (ui.selectedWaitingId) {
          ui.selectedSeatId = seat.id;
          await assignWaitingToSeat(ui.selectedWaitingId, seat.id);
          ui.selectedSeatId = null;
          ui.lastMouseClickAt = 0;
          ui.lastMouseSeatId = "";
          onFullRender();
          return;
        }

        if (occupied && canManageLayout()) {
          if (ui.lastMouseSeatId === seat.id && now - ui.lastMouseClickAt < LAYOUT_SEAT_DOUBLE_ACTIVATE_MS) {
            ui.lastMouseClickAt = 0;
            ui.lastMouseSeatId = "";
            await clearSeat(seat.id);
            ui.selectedSeatId = null;
            onFullRender();
            return;
          }

          ui.lastMouseClickAt = now;
          ui.lastMouseSeatId = seat.id;
          ui.selectedSeatId = seat.id;
          onFullRender();
          return;
        }

        ui.lastMouseClickAt = now;
        ui.lastMouseSeatId = seat.id;
        ui.selectedSeatId = seat.id;
        onFullRender();
      });

      if (!canManageLayout()) return;

      let startX = 0;
      let startY = 0;
      let moved = false;

      const onMove = (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;

        dragSeatBy(seat.id, dx, dy);
        startX = clientX;
        startY = clientY;
      };

      box.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        moved = false;

        const mm = (ev) => onMove(ev.clientX, ev.clientY);
        const mu = () => {
          window.removeEventListener("mousemove", mm);
          window.removeEventListener("mouseup", mu);

          if (moved) {
            touchEvent(true);
          }
        };

        window.addEventListener("mousemove", mm);
        window.addEventListener("mouseup", mu);
      });

      box.addEventListener(
        "touchstart",
        (e) => {
          const t = e.touches[0];
          if (!t) return;
          startX = t.clientX;
          startY = t.clientY;
          moved = false;
        },
        { passive: true }
      );

      box.addEventListener(
        "touchmove",
        (e) => {
          const t = e.touches[0];
          if (!t) return;
          onMove(t.clientX, t.clientY);
        },
        { passive: true }
      );

      box.addEventListener(
        "touchend",
        () => {
          if (moved) {
            touchEvent(true);
          }
        },
        { passive: true }
      );
    });

    layoutViewport.bindCanvasViewport(viewport, canvas);
    layoutViewport.applyCanvasViewportTransform(canvas);

    return viewport;
  }

  return { buildCanvas };
}
