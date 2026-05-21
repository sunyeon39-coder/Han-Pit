import { auth } from "../firebase.js";
import { isSeatAssignedToCurrentUser } from "../layout/layout-main-identity.js";
import { GL } from "./state.js";
import {
  escapeHtml,
  isEmptyPerson,
  seatCanvasDigitsOnly,
  toMillis,
  fmtElapsed,
  timerClass,
  getSeatPosition
} from "./utils.js";
import { getWaitingDisplayStartMs, isWaitingBlocked } from "./waiting.js";
import { updateTabUi, updateGlobalMetaToolbar } from "./toolbar.js";
import {
  applyGlobalLayoutCanvasTransform,
  wireGlobalLayoutCanvasViewport,
  refreshGlobalLayoutAlignButtonState
} from "./canvas-viewport.js";
import { wireSeatAddEventPicker } from "./seat-add-event-picker.js";
import { readPersistedSeatAddForm } from "./seat-add-form-persist.js";
import { buildEventBoxPaletteMap, getEventBoxPaletteClass } from "./event-box-palette.js";

export function updateCanvasSeatTimerClasses() {
  if (!GL.app) return;
  const root = GL.app.querySelector(".pc-canvas");
  if (!root) return;
  const now = Date.now();
  root.querySelectorAll(".seat-box[data-seat-id]").forEach((box) => {
    const id = String(box.getAttribute("data-seat-id") || "").trim();
    const s = GL.globalSeats.find((x) => String(x.seatId || "").trim() === id);
    if (!s || isEmptyPerson(String(s.person || "").trim())) {
      box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      return;
    }
    const seatedAtMs = toMillis(s.seatedAt || 0);
    const elapsed = seatedAtMs > 0 ? now - seatedAtMs : 0;
    const cls = timerClass(elapsed);
    box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    box.classList.add(cls);
  });
}

export function setPanelOpen(nextOpen) {
  GL.panelOpen = !!nextOpen;
  GL.pcPanel?.classList.toggle("open", GL.panelOpen);
  GL.app?.classList.toggle("with-panel", GL.panelOpen);
}

export function capturePanelScroll() {
  const list = GL.panelContent?.querySelector(".global-list");
  if (!list) return;
  if (GL.activeTab === "seat") {
    GL.seatListScrollTop = list.scrollTop;
  } else {
    GL.waitListScrollTop = list.scrollTop;
  }
}

export function restorePanelScroll() {
  const list = GL.panelContent?.querySelector(".global-list");
  if (!list) return;
  if (GL.activeTab === "seat") {
    list.scrollTop = GL.seatListScrollTop;
  } else {
    list.scrollTop = GL.waitListScrollTop;
  }
}

export function isTypingInPanel() {
  const el = document.activeElement;
  if (!el) return false;
  if (!(el instanceof HTMLElement)) return false;
  const modal = document.getElementById("globalSeatEditModal");
  if (modal?.classList.contains("global-seat-edit-modal--open") && modal.contains(el)) {
    return true;
  }
  const seatAddList = document.getElementById("seatAddEventList");
  if (seatAddList && !seatAddList.hidden) return true;
  if (document.getElementById("seatAddEventPick")?.contains(el)) return true;
  if (!GL.panelContent?.contains(el)) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function getSeatById(seatId = "") {
  const id = String(seatId || "").trim();
  if (!id) return null;
  return GL.globalSeats.find((s) => String(s.seatId || "").trim() === id) || null;
}

export function getDefaultEventBoxForNewSeat() {
  if (GL.urlEventId && GL.urlBoxId) return { eventId: GL.urlEventId, boxId: GL.urlBoxId };

  const se = String(sessionStorage.getItem("eventId") || "").trim();
  const sb = String(sessionStorage.getItem("boxId") || "").trim();
  if (se && sb) return { eventId: se, boxId: sb };

  const counts = new Map();
  GL.globalSeats.forEach((s) => {
    const e = String(s.currentEventId || s.mappedEventId || "").trim();
    const b = String(s.boxId || "").trim();
    if (!e || !b) return;
    const k = `${e}\t${b}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  let bestKey = "";
  let best = 0;
  counts.forEach((n, k) => {
    if (n > best) {
      best = n;
      bestKey = k;
    }
  });
  if (bestKey) {
    const [e, b] = bestKey.split("\t");
    return { eventId: e, boxId: b };
  }
  return { eventId: "1", boxId: "1" };
}

export function renderSeats(seats = []) {
  if (!GL.app) return;
  if (!seats.length) {
    GL.app.innerHTML = `
      <div class="layout-canvas-viewport" title="빈 영역을 드래그하면 화면을 이동합니다. 상단 버튼으로 확대·축소. Seat 위에서 옮기려면 Shift를 누른 채 드래그하세요.">
        <div class="canvas pc-canvas">
          <div class="canvas-inner">
            <div class="empty-panel" style="position:absolute;left:24px;top:24px;width:260px;">
              아직 생성된 전역 좌석이 없습니다.
            </div>
          </div>
        </div>
      </div>
    `;
    GL.seatCountEl.textContent = "SEAT: 0";
    if (GL.assignedCountEl) GL.assignedCountEl.textContent = "ASSIGNED: 0";
    const vp = GL.app.querySelector(".layout-canvas-viewport");
    const cv = GL.app.querySelector(".pc-canvas");
    if (vp && cv) {
      wireGlobalLayoutCanvasViewport(vp, cv);
      applyGlobalLayoutCanvasTransform(cv);
    }
    refreshGlobalLayoutAlignButtonState();
    return;
  }

  GL.seatCountEl.textContent = `SEAT: ${seats.length}`;
  if (GL.assignedCountEl) {
    const assignedCount = seats.filter((s) => !isEmptyPerson(String(s?.person || "").trim())).length;
    GL.assignedCountEl.textContent = `ASSIGNED: ${assignedCount}`;
  }
  const sorted = [...seats].sort((a, b) => (a.order || 0) - (b.order || 0));
  const paletteMap = buildEventBoxPaletteMap(sorted);
  const seatHtml = sorted.map((s, idx) => {
    const label = s.label || s.no || s.seatId || "-";
    const occupied = !isEmptyPerson(String(s.person || "").trim());
    const name = occupied ? String(s.person || "").trim() : "-";
    const isSelf = occupied && isSeatAssignedToCurrentUser(s, auth.currentUser, GL.userProfile);
    const personClass = [occupied ? "seat-person" : "seat-person is-empty", isSelf ? "is-self" : ""]
      .filter(Boolean)
      .join(" ");
    const seatId = String(s.seatId || "").trim();
    const selectedClass = GL.selectedSeatIds.has(seatId) ? "selected" : "";
    const x = Number.isFinite(Number(s.x)) ? Number(s.x) : getSeatPosition(idx).x;
    const y = Number.isFinite(Number(s.y)) ? Number(s.y) : getSeatPosition(idx).y;
    const seatedAtMs = occupied ? toMillis(s.seatedAt || 0) : 0;
    const elapsedMs = occupied ? (seatedAtMs > 0 ? Date.now() - seatedAtMs : 0) : 0;
    const timerCls = occupied ? timerClass(elapsedMs) : "";
    const paletteClass = getEventBoxPaletteClass(s, paletteMap);
    const seatBoxClass = ["seat-box", paletteClass, occupied ? "is-occupied" : "", timerCls, selectedClass]
      .filter(Boolean)
      .join(" ");
    const canvasLabel = String(s.label ?? s.no ?? "").trim() || "—";
    return `
      <div class="${seatBoxClass}" data-seat-id="${escapeHtml(seatId)}" style="left:${x}px;top:${y}px;">
        <div class="seat-title">SEAT ${escapeHtml(canvasLabel)}</div>
        <div class="${personClass}">${escapeHtml(name)}</div>
      </div>
    `;
  }).join("");

  GL.app.innerHTML = `
    <div class="layout-canvas-viewport" title="빈 영역을 드래그하면 화면을 이동합니다. 상단 버튼으로 확대·축소. Seat 위에서 옮기려면 Shift를 누른 채 드래그하세요.">
      <div class="canvas pc-canvas">
        <div class="canvas-inner">
          ${seatHtml}
        </div>
      </div>
    </div>
  `;
  updateCanvasSeatTimerClasses();
  const vp = GL.app.querySelector(".layout-canvas-viewport");
  const cv = GL.app.querySelector(".pc-canvas");
  if (vp && cv) {
    wireGlobalLayoutCanvasViewport(vp, cv);
    applyGlobalLayoutCanvasTransform(cv);
  }
  refreshGlobalLayoutAlignButtonState();
}

export function renderWaiting(waiting = []) {
  if (!GL.panelContent) return;
  capturePanelScroll();
  const waitTabActive = GL.activeTab === "wait";
  updateTabUi();

  if (!waitTabActive) {
    renderSeatPanel();
    return;
  }

  const sortedWaiting = [...waiting].sort((a, b) => {
    const da = getWaitingDisplayStartMs(a);
    const db = getWaitingDisplayStartMs(b);
    if (da !== db) return da - db;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  const waitingRows = sortedWaiting
    .map((w) => {
      const wid = String(w.id || "");
      const selected = GL.selectedWaitingId === wid;
      const blocked = isWaitingBlocked(w);
      const startMs = getWaitingDisplayStartMs(w);
      const elapsed = Date.now() - startMs;
      const tClass = timerClass(elapsed);
      const blockCheck = GL.isAdminUser
        ? `<label class="wait-block-check-wrap" title="체크 시 배치 블락 + 체크 시각 기준 타이머">
            <input type="checkbox" class="wait-block-check" data-block-wid="${escapeHtml(wid)}" ${blocked ? "checked" : ""} />
          </label>`
        : "";
      const blockBadge = blocked ? `<span class="wait-block-badge">BLOCK</span>` : "";
      const joinedAtMs =
        toMillis(
          w.joinedAt ||
            w.createdAt ||
            w.joinedAtServer ||
            w.addedAt ||
            w.carryStartedAt ||
            0
        ) || 0;
      const blockAccumulatedMs = Number(w.blockAccumulatedMs || 0) || 0;
      const blockCheckedAtMs = Number(w.blockCheckedAt || 0) || 0;
      const deleteBtn = GL.isAdminUser
        ? `<div class="mobile-wait-inline-actions">
            <button class="mobile-pill-btn danger" type="button" data-delete-wid="${escapeHtml(wid)}">삭제</button>
          </div>`
        : "";
      return `
    <div
      class="mobile-wait-row compact ${selected ? "selected" : ""} ${blocked ? "is-blocked" : ""}"
      data-wid="${escapeHtml(wid)}"
      data-wait-join-ms="${joinedAtMs}"
      data-block-accum-ms="${blockAccumulatedMs}"
      data-block-checked-at-ms="${blockCheckedAtMs}"
    >
      <div class="mobile-wait-mainline">
        <div class="mobile-wait-inline">
          ${blockCheck}
          <div class="mobile-wait-name">${escapeHtml(w.name || w.uid || "-")}</div>
          ${blockBadge}
          ${deleteBtn}
        </div>
        <div class="mobile-wait-right">
          <span class="time-chip ${tClass}" data-wait-start="${startMs}" data-wait-id="${escapeHtml(wid)}">${fmtElapsed(elapsed)}</span>
        </div>
      </div>
    </div>
  `;
    })
    .join("");

  GL.panelContent.innerHTML = `
    <div class="global-form single admin-only ${GL.isAdminUser ? "" : "hidden"}">
      <input id="manualWaitingNameInput" placeholder="-" autocomplete="off" />
      <button id="addManualWaitingBtn" class="pill-inline full" type="button">+ 대기 추가</button>
    </div>
    <div class="global-list">
      ${waitingRows || `<div class="empty-panel">현재 대기자가 없습니다.</div>`}
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
  refreshGlobalLayoutAlignButtonState();
}

export function updateWaitingTimersInPanel() {
  if (!GL.panelContent || GL.activeTab !== "wait") return;
  const chips = GL.panelContent.querySelectorAll(".time-chip[data-wait-start]");
  if (!chips.length) return;
  const now = Date.now();
  chips.forEach((chip) => {
    const start = Number(chip.getAttribute("data-wait-start") || "0");
    const elapsed = start > 0 ? Math.max(0, now - start) : 0;
    chip.textContent = fmtElapsed(elapsed);
    const cls = timerClass(elapsed);
    chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    chip.classList.add(cls);
  });
}

export function renderSeatPanel() {
  if (!GL.panelContent) return;
  capturePanelScroll();
  updateTabUi();
  const nowMs = Date.now();
  const seatedElapsedMs = (s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return -1;
    const t = toMillis(s.seatedAt || 0);
    if (!t) return -1;
    return Math.max(0, nowMs - t);
  };

  const sorted = [...GL.globalSeats].sort((a, b) => {
    if (GL.seatSortMode === "time") {
      const ea = seatedElapsedMs(a);
      const eb = seatedElapsedMs(b);
      if (ea >= 0 && eb >= 0 && ea !== eb) return eb - ea;
      if (ea >= 0 && eb < 0) return -1;
      if (ea < 0 && eb >= 0) return 1;
      return (a.order || 0) - (b.order || 0);
    }
    return (a.order || 0) - (b.order || 0);
  });
  const panelPaletteMap = buildEventBoxPaletteMap(sorted);
  const rows = sorted
    .map((s) => {
      const eventId = s.currentEventId || s.mappedEventId || "-";
      const boxId = s.boxId || "-";
      const occupied = !isEmptyPerson(String(s.person || "").trim());
      const name = occupied ? String(s.person || "").trim() : "-";
      const isSelf = occupied && isSeatAssignedToCurrentUser(s, auth.currentUser, GL.userProfile);
      const seatId = String(s.seatId || "").trim();
      const paletteClass = getEventBoxPaletteClass(s, panelPaletteMap);
      const selectedRowClass = GL.selectedSeatIds.has(seatId) ? "selected" : "";
      const seatedAt = toMillis(s.seatedAt || 0);
      const elapsed = seatedAt ? Date.now() - seatedAt : 0;
      const tClass = timerClass(elapsed);
      return `
      <div class="seat-manage-row ${paletteClass} ${selectedRowClass}" data-select-seat="${escapeHtml(seatId)}">
        <div class="seat-manage-main seat-manage-main--oneline">
          <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
            <span class="seat-manage-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
            <div class="seat-manage-namecol">
              <span class="seat-manage-name ${occupied ? "" : "is-empty"} ${isSelf ? "is-self" : ""}">${escapeHtml(name)}</span>
              <span class="meta-line seat-manage-submeta">event: ${escapeHtml(eventId)} / box: ${escapeHtml(boxId)}</span>
            </div>
          </div>
          <div class="seat-inline-actions">
            ${occupied ? `<span class="time-chip ${tClass}">${fmtElapsed(elapsed)}</span>` : `<span class="seat-manage-empty-dash">-</span>`}
            ${
              GL.isAdminUser
                ? !occupied
                  ? `<button class="pill-inline" data-assign-seat="${escapeHtml(seatId)}">여기 배치</button>`
                  : GL.selectedWaitingId
                    ? `<button class="pill-inline" data-assign-seat="${escapeHtml(seatId)}">대기↔스왑</button>`
                    : ``
                : ``
            }
            ${GL.isAdminUser && occupied ? `<button class="pill-inline seat-icon-btn warn" type="button" data-clear-seat="${escapeHtml(seatId)}" title="비우기" aria-label="비우기">🧹</button>` : ``}
            ${
              GL.isAdminUser
                ? `<button class="pill-inline seat-icon-btn" type="button" data-rename-seat="${escapeHtml(seatId)}" title="수정" aria-label="수정">⚙</button>`
                : ``
            }
            ${GL.isAdminUser ? `<button class="pill-inline seat-icon-btn danger" data-delete-seat="${escapeHtml(seatId)}" title="삭제" aria-label="삭제">🗑</button>` : ``}
          </div>
        </div>
      </div>
    `;
    })
    .join("");

  const stored = readPersistedSeatAddForm();
  const baseEb = getDefaultEventBoxForNewSeat();
  const defEb = stored
    ? { eventId: stored.eventId, boxId: stored.boxId || baseEb.boxId }
    : baseEb;
  const seatAddTitle = `카드 ID는 드롭다운에서 선택합니다. Box ID는 해당 카드(Firestore·기존 좌석) 기준으로 자동 채워지며 필요 시 수정할 수 있습니다. 비우면 ${defEb.eventId} / ${defEb.boxId} 사용.`;

  GL.panelContent.innerHTML = `
    <div
      class="global-form-seat-add admin-only ${GL.isAdminUser ? "" : "hidden"}"
      title="${escapeHtml(seatAddTitle)}"
    >
      <div class="seat-add-one-row">
        <input
          id="seatLabelInput"
          class="seat-add-input seat-add-input--label"
          type="text"
          placeholder="-"
          autocomplete="off"
          aria-label="Seat 라벨"
        />
        <div class="seat-add-event-pick" id="seatAddEventPick">
          <input type="hidden" id="seatEventInput" value="${escapeHtml(defEb.eventId)}" autocomplete="off" />
          <button
            type="button"
            class="seat-add-event-trigger"
            id="seatAddEventTrigger"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-label="카드 ID 선택"
          >
            <span class="seat-add-event-trigger-text" id="seatAddEventTriggerText" aria-hidden="true">${escapeHtml(defEb.eventId)} ▾</span>
          </button>
          <ul class="seat-add-event-list global-seat-edit-modal__select-list" id="seatAddEventList" role="listbox" hidden></ul>
        </div>
        <input
          id="seatBoxInput"
          class="seat-add-input seat-add-input--meta"
          type="text"
          placeholder="-"
          value="${escapeHtml(defEb.boxId)}"
          autocomplete="off"
          aria-label="Box ID (layout boxId)"
        />
        <button
          type="button"
          id="addSeatToolbarBtn"
          class="pill-inline primary seat-meta-btn seat-add-action-btn"
          title="+ Seat 추가"
        >
          추가
        </button>
      </div>
    </div>
    <div class="seat-sort-row">
      <button id="sortSeatOrderBtn" class="pill-inline ${GL.seatSortMode === "seat" ? "active" : ""}" type="button">Seat순</button>
      <button id="sortSeatTimeBtn" class="pill-inline ${GL.seatSortMode === "time" ? "active" : ""}" type="button" title="앉은 지 오래된 순(타이머 긴 사람이 위), 빈 좌석은 아래">시간순</button>
    </div>
    <div class="global-list">
      ${rows || `<div class="empty-panel">전역 좌석이 없습니다.</div>`}
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
  refreshGlobalLayoutAlignButtonState();
  if (GL.isAdminUser) void wireSeatAddEventPicker();
}
