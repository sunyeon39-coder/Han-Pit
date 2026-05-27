import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { openModal, closeModal } from "../shared/dom-utils.js";
import { IX } from "./state.js";

/* ===============================
   SEAT MAP (ADD ONLY)
   DOM·seatMapLayout·seatMapData·editorSeats 는 ./state.js 의 IX 에서 참조합니다.
=============================== */

const MAP_BASE_WIDTH = 1400;
const MAP_BASE_HEIGHT = 900;
const MAP_SEAT_SIZE = 48;
const MAP_PADDING = 120;
let seatMapEditMode = false;
/** 맵 편집 모드에서 정렬 대상 Seat (⌘/Ctrl+클릭 다중 선택) */
const seatMapSelectedIds = new Set();

/* ===============================
   MAP SIZE HELPERS
=============================== */

function getSeatMapBounds(seats = []) {
  if (!Array.isArray(seats) || seats.length === 0) {
    return {
      width: MAP_BASE_WIDTH,
      height: MAP_BASE_HEIGHT
    };
  }

  let maxX = 0;
  let maxY = 0;

  seats.forEach((seat) => {
    const x = Number(seat?.x || 0);
    const y = Number(seat?.y || 0);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  return {
    width: Math.max(MAP_BASE_WIDTH, Math.ceil(maxX + MAP_SEAT_SIZE + MAP_PADDING)),
    height: Math.max(MAP_BASE_HEIGHT, Math.ceil(maxY + MAP_SEAT_SIZE + MAP_PADDING))
  };
}

function applySeatMapCanvasSize(canvasEl, seats = []) {
  if (!canvasEl) return;

  const bounds = getSeatMapBounds(seats);
  canvasEl.style.width = `${bounds.width}px`;
  canvasEl.style.height = `${bounds.height}px`;
}

/** 기본 진입: 캔버스 왼쪽 위(0,0) 기준 */
function focusSeatMapViewportTopLeft(scrollEl) {
  if (!scrollEl) return;
  scrollEl.scrollLeft = 0;
  scrollEl.scrollTop = 0;
}

function isSeatMapMultiSelectPointer(e) {
  return !!(e && (e.metaKey || e.ctrlKey));
}

function applySeatMapSelectionClick(seatId = "", multi = false) {
  const sid = String(seatId || "").trim();
  if (!sid) return;
  if (multi) {
    if (seatMapSelectedIds.has(sid)) seatMapSelectedIds.delete(sid);
    else seatMapSelectedIds.add(sid);
    return;
  }
  if (seatMapSelectedIds.size === 1 && seatMapSelectedIds.has(sid)) {
    seatMapSelectedIds.clear();
  } else {
    seatMapSelectedIds.clear();
    seatMapSelectedIds.add(sid);
  }
}

function syncSeatMapSelectionUi() {
  if (!IX.seatMapCanvas) return;
  IX.seatMapCanvas.querySelectorAll(".map-seat[data-seat-id]").forEach((el) => {
    const sid = String(el.getAttribute("data-seat-id") || "").trim();
    el.classList.toggle("selected", seatMapSelectedIds.has(sid));
  });
  refreshSeatMapEditorToolbar();
}

function refreshSeatMapEditorToolbar() {
  const alignDisabled = seatMapSelectedIds.size < 2;
  if (IX.alignSeatMapRowBtn) IX.alignSeatMapRowBtn.disabled = alignDisabled;
  if (IX.alignSeatMapColBtn) IX.alignSeatMapColBtn.disabled = alignDisabled;
  if (IX.deleteSeatMapBtn) IX.deleteSeatMapBtn.disabled = seatMapSelectedIds.size < 1;
}

function alignEditorSeats(axis = "") {
  const ax = String(axis || "").trim();
  if (ax !== "row" && ax !== "col") return;
  if (!seatMapEditMode) return;

  const ids = [...seatMapSelectedIds];
  if (ids.length < 2) {
    alert("정렬하려면 Seat을 2개 이상 선택해 주세요.\n(⌘ 또는 Ctrl을 누른 채 클릭하면 여러 개 선택)");
    return;
  }

  const seats = ids
    .map((id) => IX.editorSeats.find((s) => String(s.id || "") === id))
    .filter(Boolean);
  if (seats.length < 2) return;

  const isRow = ax === "row";
  let sum = 0;
  for (const seat of seats) {
    sum += isRow ? Number(seat.y) || 0 : Number(seat.x) || 0;
  }
  const aligned = Math.round(sum / seats.length);

  seats.forEach((seat) => {
    if (isRow) {
      seat.y = aligned;
      seat.x = Math.round(Number(seat.x) || 0);
    } else {
      seat.x = aligned;
      seat.y = Math.round(Number(seat.y) || 0);
    }
  });

  renderEditor();
}

function deleteSelectedEditorSeats() {
  if (!seatMapEditMode) return;

  const ids = [...seatMapSelectedIds];
  if (!ids.length) {
    alert("삭제할 Seat을 선택해 주세요.");
    return;
  }

  const idSet = new Set(ids);
  const labels = ids
    .map((id) => {
      const seat = IX.editorSeats.find((s) => String(s.id || "") === id);
      return String(seat?.label || id).trim() || id;
    })
    .join(", ");

  const assignedCount = ids.filter((id) => IX.seatMapData.has(id)).length;
  let msg =
    ids.length === 1
      ? `Seat "${labels}"을(를) 맵에서 삭제할까요?`
      : `선택한 Seat ${ids.length}개(${labels})를 맵에서 삭제할까요?`;
  if (assignedCount > 0) {
    msg +=
      "\n\n※ 일부 Seat은 현재 이벤트 배치에 표시 중입니다. 맵 레이아웃에서만 제거됩니다.";
  }
  if (!confirm(msg)) return;

  IX.editorSeats = IX.editorSeats.filter((s) => !idSet.has(String(s.id || "")));
  clearSeatMapSelection();
  renderEditor();
}

function clearSeatMapSelection() {
  seatMapSelectedIds.clear();
  syncSeatMapSelectionUi();
}

/* ===============================
   LOAD MAP LAYOUT
=============================== */

async function loadSeatMapLayout() {
  try {
    const snap = await getDoc(doc(db, "layout_shared", "floor_map"));

    if (!snap.exists()) {
      IX.seatMapLayout = [];
      applySeatMapCanvasSize(IX.seatMapCanvas, []);
      return;
    }

    const data = snap.data() || {};
    IX.seatMapLayout = Array.isArray(data.seats) ? data.seats : [];
    applySeatMapCanvasSize(IX.seatMapCanvas, IX.seatMapLayout);
  } catch (err) {
    console.error("loadSeatMapLayout error", err);
  }
}

/* ===============================
   RENDER MAP
=============================== */

function renderSeatMap() {
  if (!IX.seatMapCanvas) return;

  IX.seatMapCanvas.innerHTML = "";
  applySeatMapCanvasSize(IX.seatMapCanvas, IX.seatMapLayout);

  IX.seatMapLayout.forEach((seat) => {
    const seatId = String(seat.id || "");
    const x = Number(seat.x || 0);
    const y = Number(seat.y || 0);

    const info = IX.seatMapData.get(seatId);

    const el = document.createElement("div");
    el.className = "map-seat";

    if (info) {
      el.classList.add("filled");
    }

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.innerText = seat.label || seatId;

    IX.seatMapCanvas.appendChild(el);
  });
}

function setSeatMapEditMode(editing) {
  seatMapEditMode = editing === true;
  if (!seatMapEditMode) clearSeatMapSelection();
  IX.seatMapEditActions?.classList.toggle("hidden", !seatMapEditMode);
  const canEdit = IX.seatMapOpenEditorBtn?.dataset.canEdit === "1";
  if (IX.seatMapOpenEditorBtn) {
    IX.seatMapOpenEditorBtn.classList.toggle("hidden", seatMapEditMode || !canEdit);
  }
  refreshSeatMapEditorToolbar();
}

/* ===============================
   WATCH SEAT DATA
=============================== */

function bindSeatMapRealtime() {
  onSnapshot(
    collection(db, "layout_events"),
    (snap) => {
      IX.seatMapData.clear();

      snap.docs.forEach((d) => {
        const data = d.data() || {};
        const seats = Array.isArray(data.seats) ? data.seats : [];

        seats.forEach((seat) => {
          const id = String(seat.id || seat.label || "");
          if (!id) return;

          IX.seatMapData.set(id, {
            eventId: data.eventId,
            person: seat.person
          });
        });
      });

      if (!seatMapEditMode) renderSeatMap();
    },
    (err) => {
      console.error("bindSeatMapRealtime error:", err);
    }
  );
}

/* ===============================
   MAP EDITOR (same modal)
=============================== */

/* load map */

async function loadMapEditor() {
  const snap = await getDoc(doc(db, "layout_shared", "floor_map"));

  clearSeatMapSelection();
  if (!snap.exists()) {
    IX.editorSeats = [];
  } else {
    const data = snap.data() || {};
    IX.editorSeats = Array.isArray(data.seats) ? data.seats : [];
  }

  renderEditor();
}

/* render */

function renderEditor() {
  if (!IX.seatMapCanvas) return;

  IX.seatMapCanvas.innerHTML = "";
  applySeatMapCanvasSize(IX.seatMapCanvas, IX.editorSeats);

  IX.editorSeats.forEach((seat) => {
    const seatId = String(seat.id || "");
    const el = document.createElement("div");
    el.className = "map-seat";
    if (seatMapSelectedIds.has(seatId)) el.classList.add("selected");
    el.setAttribute("data-seat-id", seatId);

    el.innerText = seat.label;
    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;

    enableDrag(el, seat);
    IX.seatMapCanvas.appendChild(el);
  });

  refreshSeatMapEditorToolbar();
}

/* drag */

function buildSeatMapDragGroup(primarySeatId = "") {
  const sid = String(primarySeatId || "").trim();
  const moveIds =
    sid && seatMapSelectedIds.has(sid) && seatMapSelectedIds.size > 1
      ? [...seatMapSelectedIds]
      : sid
        ? [sid]
        : [];

  return moveIds
    .map((id) => {
      const s = IX.editorSeats.find((item) => String(item.id || "") === id);
      if (!s) return null;
      return {
        seat: s,
        startX: Number(s.x) || 0,
        startY: Number(s.y) || 0
      };
    })
    .filter(Boolean);
}

function applySeatMapDragGroupDelta(dragGroup, primarySeatId, newX, newY) {
  if (!dragGroup?.length || !IX.seatMapCanvas) return;
  const sid = String(primarySeatId || "").trim();
  const primary =
    dragGroup.find((entry) => String(entry.seat.id || "") === sid) || dragGroup[0];
  const deltaX = newX - primary.startX;
  const deltaY = newY - primary.startY;

  for (const { seat: s, startX, startY } of dragGroup) {
    s.x = startX + deltaX;
    s.y = startY + deltaY;
    const id = String(s.id || "");
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const node = IX.seatMapCanvas.querySelector(`.map-seat[data-seat-id="${escapedId}"]`);
    if (node) {
      node.style.left = `${s.x}px`;
      node.style.top = `${s.y}px`;
    }
  }
}

function enableDrag(el, seat) {
  const seatId = String(seat.id || "");
  let offsetX = 0;
  let offsetY = 0;
  let startClientX = 0;
  let startClientY = 0;
  let dragging = false;
  let moved = false;
  /** @type {Array<{ seat: object, startX: number, startY: number }> | null} */
  let dragGroup = null;

  const beginPointerSession = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    dragging = false;
    moved = false;
    dragGroup = null;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
    startClientX = e.clientX;
    startClientY = e.clientY;

    const onMove = (ev) => {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        moved = true;
        dragging = true;
        dragGroup = buildSeatMapDragGroup(seatId);
      }
      if (!dragging || !dragGroup?.length) return;

      const rect = IX.seatMapCanvas.getBoundingClientRect();
      const newX = ev.clientX - rect.left - offsetX;
      const newY = ev.clientY - rect.top - offsetY;
      applySeatMapDragGroupDelta(dragGroup, seatId, newX, newY);
    };

    const onUp = (ev) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) {
        applySeatMapSelectionClick(seatId, isSeatMapMultiSelectPointer(ev));
        syncSeatMapSelectionUi();
        return;
      }
      dragging = false;
      applySeatMapCanvasSize(IX.seatMapCanvas, IX.editorSeats);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  el.addEventListener("pointerdown", beginPointerSession);
}

/* add seat */

let indexSeatMapControlsWired = false;

export function wireSeatMapListeners() {
  if (indexSeatMapControlsWired) return;

  try {
  bindSeatMapRealtime();

  IX.seatMapBtn?.addEventListener("click", async () => {
    setSeatMapEditMode(false);
    await loadSeatMapLayout();
    renderSeatMap();
    openModal(IX.seatMapModal);

    requestAnimationFrame(() => {
      focusSeatMapViewportTopLeft(IX.seatMapScroll);
    });
  });

  IX.seatMapCloseBtn?.addEventListener("click", () => {
    setSeatMapEditMode(false);
    closeModal(IX.seatMapModal);
  });

  IX.addSeatBtn?.addEventListener("click", () => {
  const id = String(IX.editorSeats.length + 1);

  const pad = MAP_PADDING / 2;
  const step = MAP_SEAT_SIZE + 16;
  const index = IX.editorSeats.length;
  IX.editorSeats.push({
    id,
    label: id,
    x: pad + (index % 8) * step,
    y: pad + Math.floor(index / 8) * step
  });

  seatMapSelectedIds.clear();
  seatMapSelectedIds.add(id);
  renderEditor();

  requestAnimationFrame(() => {
    focusSeatMapViewportTopLeft(IX.seatMapScroll);
  });
});

  IX.deleteSeatMapBtn?.addEventListener("click", () => {
    deleteSelectedEditorSeats();
  });

  IX.alignSeatMapRowBtn?.addEventListener("click", () => {
    alignEditorSeats("row");
  });

  IX.alignSeatMapColBtn?.addEventListener("click", () => {
    alignEditorSeats("col");
  });

/* save */

  IX.saveMapBtn?.addEventListener("click", async () => {
  await setDoc(
    doc(db, "layout_shared", "floor_map"),
    { seats: IX.editorSeats },
    { merge: true }
  );

    IX.seatMapLayout = [...IX.editorSeats];
    setSeatMapEditMode(false);
    renderSeatMap();
    alert("맵 저장 완료");
  });

  IX.seatMapOpenEditorBtn?.addEventListener("click", async () => {
    setSeatMapEditMode(true);
    await loadMapEditor();

    requestAnimationFrame(() => {
      focusSeatMapViewportTopLeft(IX.seatMapScroll);
    });
  });

  IX.seatMapCanvas?.addEventListener("mousedown", (e) => {
    if (!seatMapEditMode) return;
    if (e.target.closest(".map-seat")) return;
    clearSeatMapSelection();
  });

  indexSeatMapControlsWired = true;
  } catch (err) {
    console.error("wireSeatMapListeners error:", err);
  }
}
