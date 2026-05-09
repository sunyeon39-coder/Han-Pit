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

function centerSeatMapViewport(scrollEl, canvasEl) {
  if (!scrollEl || !canvasEl) return;

  const maxLeft = Math.max(0, canvasEl.scrollWidth - scrollEl.clientWidth);
  const maxTop = Math.max(0, canvasEl.scrollHeight - scrollEl.clientHeight);

  scrollEl.scrollLeft = Math.min(maxLeft, Math.max(0, (canvasEl.scrollWidth - scrollEl.clientWidth) / 2));
  scrollEl.scrollTop = Math.min(maxTop, Math.max(0, (canvasEl.scrollHeight - scrollEl.clientHeight) / 2));
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
  IX.seatMapEditActions?.classList.toggle("hidden", !seatMapEditMode);
  const canEdit = IX.seatMapOpenEditorBtn?.dataset.canEdit === "1";
  if (IX.seatMapOpenEditorBtn) {
    IX.seatMapOpenEditorBtn.classList.toggle("hidden", seatMapEditMode || !canEdit);
  }
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
    const el = document.createElement("div");
    el.className = "map-seat";

    el.innerText = seat.label;
    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;

    enableDrag(el, seat);
    IX.seatMapCanvas.appendChild(el);
  });
}

/* drag */

function enableDrag(el, seat) {
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;

  el.addEventListener("mousedown", (e) => {
    dragging = true;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;

    const rect = IX.seatMapCanvas.getBoundingClientRect();

    seat.x = e.clientX - rect.left - offsetX;
    seat.y = e.clientY - rect.top - offsetY;

    el.style.left = `${seat.x}px`;
    el.style.top = `${seat.y}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    applySeatMapCanvasSize(IX.seatMapCanvas, IX.editorSeats);
  });
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
      centerSeatMapViewport(IX.seatMapScroll, IX.seatMapCanvas);
    });
  });

  IX.seatMapCloseBtn?.addEventListener("click", () => {
    setSeatMapEditMode(false);
    closeModal(IX.seatMapModal);
  });

  IX.addSeatBtn?.addEventListener("click", () => {
  const id = String(IX.editorSeats.length + 1);

  IX.editorSeats.push({
    id,
    label: id,
    x: 100,
    y: 100
  });

  renderEditor();

  requestAnimationFrame(() => {
    if (!IX.seatMapScroll || !IX.seatMapCanvas) return;
    IX.seatMapScroll.scrollLeft = Math.max(0, IX.editorSeats[IX.editorSeats.length - 1].x - 120);
    IX.seatMapScroll.scrollTop = Math.max(0, IX.editorSeats[IX.editorSeats.length - 1].y - 120);
  });
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
      centerSeatMapViewport(IX.seatMapScroll, IX.seatMapCanvas);
    });
  });

  indexSeatMapControlsWired = true;
  } catch (err) {
    console.error("wireSeatMapListeners error:", err);
  }
}
