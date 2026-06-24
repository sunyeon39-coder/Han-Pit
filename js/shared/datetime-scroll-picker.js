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

function msFromParts(parts) {
  const d = new Date(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour24FromParts(parts),
    Number(parts.minute),
    0,
    0
  );
  return d.getTime();
}

function isDateTimeInRange(parts, minMs, maxMs) {
  const ms = msFromParts(parts);
  return ms >= minMs && ms <= maxMs;
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

function readPickerParts(sheet) {
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

  const ampms = [];
  for (const entry of [
    { value: "am", label: "오전" },
    { value: "pm", label: "오후" }
  ]) {
    let valid = false;
    for (let h12 = 1; h12 <= 12 && !valid; h12++) {
      for (let min = 0; min <= 59; min++) {
        if (
          isDateTimeInRange(
            { ...parts, ampm: entry.value, hour12: h12, minute: min },
            minMs,
            maxMs
          )
        ) {
          valid = true;
          break;
        }
      }
    }
    if (valid) ampms.push(entry);
  }

  const hour12s = [];
  for (let h12 = 1; h12 <= 12; h12++) {
    let valid = false;
    for (let min = 0; min <= 59; min++) {
      if (isDateTimeInRange({ ...parts, hour12: h12, minute: min }, minMs, maxMs)) {
        valid = true;
        break;
      }
    }
    if (valid) hour12s.push({ value: h12, label: `${h12}시` });
  }

  const hour24 = hour24FromParts(parts);
  const minutes = [];
  const minuteStart =
    parts.year === minP.year &&
    parts.month === minP.month &&
    parts.day === minP.day &&
    hour24 === minP.hour
      ? minP.minute
      : 0;
  const minuteEnd =
    parts.year === maxP.year &&
    parts.month === maxP.month &&
    parts.day === maxP.day &&
    hour24 === maxP.hour
      ? maxP.minute
      : 59;
  for (let m = minuteStart; m <= minuteEnd; m++) {
    minutes.push({ value: m, label: `${pad2(m)}분` });
  }

  const safeParts = {
    ...parts,
    month: Math.min(Math.max(parts.month, monthStart), monthEnd),
    day: Math.min(Math.max(parts.day, dayStart), dayEnd),
    ampm: ampms.some((a) => a.value === parts.ampm) ? parts.ampm : ampms[0]?.value || "am",
    hour12: hour12s.some((h) => h.value === parts.hour12)
      ? parts.hour12
      : hour12s[0]?.value ?? parts.hour12,
    minute: Math.min(Math.max(parts.minute, minuteStart), minuteEnd)
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
  let parts = readPickerParts(sheet);
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

  const dateCols = modalEl.querySelector(".datetime-scroll-picker-columns--date");
  const timeCols = modalEl.querySelector(".datetime-scroll-picker-columns--time");
  buildColumns(dateCols, timeCols, partsFromMs(initial), safeMin, safeMax);

  return new Promise((resolve) => {
    pendingResolve = resolve;
    openModal(modalEl);
  });
}
