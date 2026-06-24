import { closeModal, openModal } from "./dom-utils.js";

const ITEM_H = 40;
const VISIBLE_ROWS = 5;
const COL_H = ITEM_H * VISIBLE_ROWS;

let modalEl = null;
let pendingResolve = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clampMs(ms, minMs, maxMs) {
  return Math.min(maxMs, Math.max(minMs, Number(ms) || Date.now()));
}

function partsFromMs(ms) {
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes()
  };
}

function msFromParts(parts) {
  const d = new Date(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    0,
    0
  );
  return d.getTime();
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
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
        <div class="datetime-scroll-picker-columns"></div>
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

function readPickerParts(root) {
  const parts = {};
  root.querySelectorAll(".dt-scroll-col").forEach((col) => {
    const key = col.dataset.part;
    const item = getCenteredItem(col);
    parts[key] = Number(item?.dataset.value || 0);
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
    if (Number(item.value) === Number(selectedValue)) {
      btn.dataset.selected = "1";
    }
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

function buildColumns(container, parts, minMs, maxMs) {
  container.innerHTML = "";
  const minP = partsFromMs(minMs);
  const maxP = partsFromMs(maxMs);

  const years = [];
  for (let y = minP.year; y <= maxP.year; y++) {
    years.push({ value: y, label: `${y}년` });
  }

  const months = [];
  const monthStart = parts.year === minP.year ? minP.month : 1;
  const monthEnd = parts.year === maxP.year ? maxP.month : 12;
  for (let m = monthStart; m <= monthEnd; m++) {
    months.push({ value: m, label: `${m}월` });
  }

  const maxDay = daysInMonth(parts.year, parts.month);
  const dayStart =
    parts.year === minP.year && parts.month === minP.month ? minP.day : 1;
  const dayEnd =
    parts.year === maxP.year && parts.month === maxP.month
      ? Math.min(maxP.day, maxDay)
      : maxDay;
  const days = [];
  for (let d = dayStart; d <= dayEnd; d++) {
    days.push({ value: d, label: `${d}일` });
  }

  const hours = [];
  for (let h = 0; h < 24; h++) {
    const useHour =
      parts.year === minP.year &&
      parts.month === minP.month &&
      parts.day === minP.day
        ? h >= minP.hour
        : true;
    const useHourMax =
      parts.year === maxP.year &&
      parts.month === maxP.month &&
      parts.day === maxP.day
        ? h <= maxP.hour
        : true;
    if (!useHour || !useHourMax) continue;
    const ampm = h < 12 ? "오전" : "오후";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    hours.push({ value: h, label: `${ampm} ${h12}시` });
  }

  const minutes = [];
  const minuteStart =
    parts.year === minP.year &&
    parts.month === minP.month &&
    parts.day === minP.day &&
    parts.hour === minP.hour
      ? minP.minute
      : 0;
  const minuteEnd =
    parts.year === maxP.year &&
    parts.month === maxP.month &&
    parts.day === maxP.day &&
    parts.hour === maxP.hour
      ? maxP.minute
      : 59;
  for (let m = minuteStart; m <= minuteEnd; m++) {
    minutes.push({ value: m, label: `${pad2(m)}분` });
  }

  const safeParts = {
    ...parts,
    month: Math.min(Math.max(parts.month, monthStart), monthEnd),
    day: Math.min(Math.max(parts.day, dayStart), dayEnd),
    hour: hours.some((h) => h.value === parts.hour)
      ? parts.hour
      : hours[0]?.value ?? parts.hour,
    minute: Math.min(Math.max(parts.minute, minuteStart), minuteEnd)
  };

  container.appendChild(buildColumn("year", years, safeParts.year));
  container.appendChild(buildColumn("month", months, safeParts.month));
  container.appendChild(buildColumn("day", days, safeParts.day));
  container.appendChild(buildColumn("hour", hours, safeParts.hour));
  container.appendChild(buildColumn("minute", minutes, safeParts.minute));
}

let pickerState = null;

function confirmPick() {
  if (!modalEl || !pickerState) {
    finishPick(null);
    return;
  }
  const cols = modalEl.querySelector(".datetime-scroll-picker-columns");
  let parts = readPickerParts(cols);
  let ms = msFromParts(parts);
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

  const cols = modalEl.querySelector(".datetime-scroll-picker-columns");
  buildColumns(cols, partsFromMs(initial), safeMin, safeMax);

  return new Promise((resolve) => {
    pendingResolve = resolve;
    openModal(modalEl);
  });
}
