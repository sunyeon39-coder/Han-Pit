import { closeModal, openModal } from "./dom-utils.js";

const ITEM_H = 40;
const VISIBLE_ROWS = 5;
const COL_H = ITEM_H * VISIBLE_ROWS;

let modalEl = null;
let pendingResolve = null;

function clampMs(ms, minMs, maxMs) {
  return Math.min(maxMs, Math.max(minMs, Number(ms) || Date.now()));
}

function partsFromMs(ms) {
  const d = new Date(ms);
  const hour = d.getHours();
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour,
    ampm: hour < 12 ? "am" : "pm",
    hour12: hour % 12 === 0 ? 12 : hour % 12,
    minute: d.getMinutes()
  };
}

function hour24FromParts(parts) {
  const hour12 = Number(parts.hour12) || 12;
  let h = hour12 % 12;
  if (String(parts.ampm || "am") === "pm") h += 12;
  return h;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function normalizeParts(parts) {
  const year = Number(parts.year);
  const month = Math.min(12, Math.max(1, Number(parts.month) || 1));
  const maxDay = daysInMonth(year, month);
  const day = Math.min(maxDay, Math.max(1, Number(parts.day) || 1));
  const minute = Math.min(59, Math.max(0, Number(parts.minute) || 0));
  const hour12 = Math.min(12, Math.max(1, Number(parts.hour12) || 12));
  return {
    year,
    month,
    day,
    minute,
    hour12,
    ampm: String(parts.ampm || "am") === "pm" ? "pm" : "am"
  };
}

function msFromParts(parts) {
  const p = normalizeParts(parts);
  const d = new Date(
    p.year,
    p.month - 1,
    p.day,
    hour24FromParts(p),
    p.minute,
    0,
    0
  );
  return d.getTime();
}

function ensureModal() {
  if (modalEl) return modalEl;

  modalEl = document.createElement("div");
  modalEl.id = "datetimeScrollPickerModal";
  modalEl.className = "modal-backdrop datetime-scroll-picker-backdrop";
  modalEl.innerHTML = `
    <div class="datetime-scroll-picker-sheet" role="dialog" aria-modal="true">
      <div class="datetime-scroll-picker-head">
        <button type="button" class="mini-btn datetime-scroll-picker-cancel">취소</button>
        <h3 class="datetime-scroll-picker-title">시간 선택</h3>
        <button type="button" class="mini-btn datetime-scroll-picker-confirm">확인</button>
      </div>
      <div class="datetime-scroll-picker-columns-wrap">
        <div class="datetime-scroll-picker-highlight" aria-hidden="true"></div>
        <div class="datetime-scroll-picker-columns datetime-scroll-picker-columns--date"></div>
        <div class="datetime-scroll-picker-highlight datetime-scroll-picker-highlight--time" aria-hidden="true"></div>
        <div class="datetime-scroll-picker-columns datetime-scroll-picker-columns--time"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.querySelector(".datetime-scroll-picker-cancel")?.addEventListener("click", () => {
    finishPick(null);
  });
  modalEl.querySelector(".datetime-scroll-picker-confirm")?.addEventListener("click", () => {
    confirmPick();
  });
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) finishPick(null);
  });

  return modalEl;
}

function finishPick(value) {
  closeModal(modalEl);
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.(value);
}

function getCenteredItem(col) {
  const rect = col.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  const items = col.querySelectorAll(".dt-scroll-item");
  let best = null;
  let bestDist = Infinity;
  items.forEach((item) => {
    const ir = item.getBoundingClientRect();
    const iy = ir.top + ir.height / 2;
    const dist = Math.abs(iy - centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  });
  return best;
}

function scrollItemToCenter(col, item) {
  if (!col || !item) return;
  const offset = item.offsetTop - (COL_H / 2 - ITEM_H / 2);
  col.scrollTop = Math.max(0, offset);
}

function snapAllColumns(sheet) {
  sheet.querySelectorAll(".dt-scroll-col").forEach((col) => {
    const centered = getCenteredItem(col);
    if (centered) scrollItemToCenter(col, centered);
  });
}

function readPickerParts(sheet) {
  snapAllColumns(sheet);
  const parts = {};
  sheet.querySelectorAll(".dt-scroll-col").forEach((col) => {
    const key = col.dataset.part;
    const item = getCenteredItem(col);
    const raw = item?.dataset.value ?? "";
    parts[key] = key === "ampm" ? String(raw) : Number(raw);
  });
  return parts;
}

function buildColumn(part, items, selectedValue) {
  const col = document.createElement("div");
  col.className = "dt-scroll-col";
  col.dataset.part = part;

  const pad = document.createElement("div");
  pad.className = "dt-scroll-col-pad";
  pad.style.height = `${(COL_H - ITEM_H) / 2}px`;
  col.appendChild(pad);

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dt-scroll-item";
    btn.dataset.value = String(item.value);
    btn.textContent = item.label;
    const selected =
      part === "ampm"
        ? String(item.value) === String(selectedValue)
        : Number(item.value) === Number(selectedValue);
    if (selected) btn.dataset.selected = "1";
    col.appendChild(btn);
  }

  const pad2el = pad.cloneNode(true);
  col.appendChild(pad2el);

  let scrollTimer = null;
  col.addEventListener("scroll", () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const centered = getCenteredItem(col);
      if (centered) scrollItemToCenter(col, centered);
    }, 80);
  });

  requestAnimationFrame(() => {
    const selected =
      col.querySelector('.dt-scroll-item[data-selected="1"]') ||
      col.querySelector(".dt-scroll-item");
    scrollItemToCenter(col, selected);
  });

  return col;
}

function buildColumns(dateContainer, timeContainer, parts, minMs, maxMs) {
  dateContainer.innerHTML = "";
  timeContainer.innerHTML = "";
  const minP = partsFromMs(minMs);
  const maxP = partsFromMs(maxMs);

  const years = [];
  for (let y = minP.year; y <= maxP.year; y++) {
    years.push({ value: y, label: `${y}년` });
  }

  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push({ value: m, label: `${m}월` });
  }

  const days = [];
  for (let d = 1; d <= 31; d++) {
    days.push({ value: d, label: `${d}일` });
  }

  const ampms = [
    { value: "am", label: "오전" },
    { value: "pm", label: "오후" }
  ];

  const hour12s = [];
  for (let h12 = 1; h12 <= 12; h12++) {
    hour12s.push({ value: h12, label: `${h12}시` });
  }

  const minutes = [];
  for (let m = 0; m <= 59; m++) {
    minutes.push({ value: m, label: m === 0 ? "00분" : `${m}분` });
  }

  const safeParts = {
    ...parts,
    month: Math.min(Math.max(parts.month, 1), 12),
    day: Math.min(Math.max(parts.day, 1), 31),
    ampm: parts.ampm === "pm" ? "pm" : "am",
    hour12: Math.min(Math.max(parts.hour12 || 12, 1), 12),
    minute: Math.min(Math.max(Number(parts.minute) || 0, 0), 59)
  };

  dateContainer.appendChild(buildColumn("year", years, safeParts.year));
  dateContainer.appendChild(buildColumn("month", months, safeParts.month));
  dateContainer.appendChild(buildColumn("day", days, safeParts.day));
  timeContainer.appendChild(buildColumn("ampm", ampms, safeParts.ampm));
  timeContainer.appendChild(buildColumn("hour12", hour12s, safeParts.hour12));
  timeContainer.appendChild(buildColumn("minute", minutes, safeParts.minute));
}

let pickerState = null;

function confirmPick() {
  if (!modalEl || !pickerState) {
    finishPick(null);
    return;
  }
  const sheet = modalEl.querySelector(".datetime-scroll-picker-sheet");
  const parts = readPickerParts(sheet);
  let ms = msFromParts(parts);
  if (!Number.isFinite(ms)) {
    finishPick(null);
    return;
  }
  ms = clampMs(ms, pickerState.minMs, pickerState.maxMs);
  finishPick(ms);
}

/**
 * 스크롤 휠 형태 날짜·시간 선택기
 * @returns {Promise<number|null>} 확인 시 ms, 취소 시 null
 */
export function openDatetimeScrollPicker({
  initialMs = Date.now(),
  minMs = Date.now() - 45 * 24 * 60 * 60 * 1000,
  maxMs = Date.now(),
  title = "시간 선택"
} = {}) {
  ensureModal();
  const safeMax = Number(maxMs) || Date.now();
  const safeMin = Math.min(Number(minMs) || safeMax - 45 * 24 * 60 * 60 * 1000, safeMax);
  const initial = clampMs(initialMs, safeMin, safeMax);
  pickerState = { minMs: safeMin, maxMs: safeMax };

  const titleEl = modalEl.querySelector(".datetime-scroll-picker-title");
  if (titleEl) titleEl.textContent = title;

  const dateCols = modalEl.querySelector(".datetime-scroll-picker-columns--date");
  const timeCols = modalEl.querySelector(".datetime-scroll-picker-columns--time");
  buildColumns(dateCols, timeCols, partsFromMs(initial), safeMin, safeMax);

  return new Promise((resolve) => {
    pendingResolve = resolve;
    openModal(modalEl);
  });
}
