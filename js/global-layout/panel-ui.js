import { auth } from "../firebase.js";
import { isSeatAssignedToCurrentUser } from "../layout/layout-main-identity.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { GL } from "./state.js";
import { updateGlobalLayoutMetaCounts, updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import {
  escapeHtml,
  isEmptyPerson,
  seatCanvasDigitsOnly,
  getGlobalSeatRowKey,
  compareSeatsByCanvasLabel,
  compareGlobalSeatsBySeatedTimeOldest,
  getGlobalSeatSeatedAtMs,
  toMillis,
  fmtElapsed,
  timerClass,
  getSeatPosition,
  getSeatById
} from "./utils.js";
import { renderGlobalLayoutMobile } from "./mobile-panel-render.js";
import {
  getPcSeatColEl,
  getPcSeatScrollEl,
  getPcWaitColEl,
  getPcWaitScrollEl
} from "./pc-panel-split.js";
import { getWaitingDisplayStartMs, isWaitingBlocked, sortWaitingForDisplay, resolveSelectedWaitingForAssign, getCurrentTournamentWaiting } from "./waiting.js";
import {
  buildOperatorLegendHtml,
  buildWaitingPickBadgesHtml,
  waitingRowPickClass
} from "./waiting-picks.js";
import { updateTabUi, updateGlobalMetaToolbar } from "./toolbar.js";
import {
  applyGlobalLayoutCanvasTransform,
  wireGlobalLayoutCanvasViewport,
  refreshGlobalLayoutAlignButtonState
} from "./canvas-viewport.js";
import { wireSeatAddEventPicker, getSeatAddEventsCache } from "./seat-add-event-picker.js";
import { readPersistedSeatAddForm } from "./seat-add-form-persist.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import { resolveSeatEventBox } from "./utils.js";
import { buildEventBoxPaletteMap, getEventBoxPaletteClass } from "./event-box-palette.js";
import { syncSeatBoxesInContainer } from "../shared/sync-seat-box-dom.js";
import { canManageGlobalLayoutOps, canViewGlobalLayoutSeatHistory } from "./ops-access.js";

function buildGlobalSeatsByIdMap() {
  const map = new Map();
  for (const seat of GL.globalSeats || []) {
    const sid = String(seat?.seatId || "").trim();
    if (sid) map.set(sid, seat);
  }
  return map;
}

function waitingPanelFingerprint(waiting = []) {
  return waiting
    .map((w, index) => {
      const wid = String(w.id || "").trim();
      const blocked = isWaitingBlocked(w) ? 1 : 0;
      const pickUi = waitingRowPickClass(wid);
      return `${index}:${wid}|${String(w.name || w.uid || "").trim()}|${blocked}|${pickUi.isSelected ? 1 : 0}|${Number(w.blockAccumulatedMs || 0)}|${Number(w.blockCheckedAt || 0)}`;
    })
    .join(";");
}

export function invalidateWaitingPanelFingerprint() {
  GL._waitingPanelFp = "";
}

function seatPanelFingerprint(seats = []) {
  const sel = String(GL.selectedWaitingId || "").trim();
  return `${sel}|${GL.seatSortMode}|${seats
    .map((s) => {
      const sid = String(s.seatId || "").trim();
      const occupied = !isEmptyPerson(String(s.person || "").trim());
      const selected = GL.selectedSeatIds.has(getGlobalSeatRowKey(s)) ? 1 : 0;
      return `${sid}|${String(s.person || "").trim()}|${occupied ? 1 : 0}|${selected}|${String(s.label ?? s.no ?? "")}`;
    })
    .join(";")}`;
}

function buildGlobalSeatBoxState(s, idx, paletteMap) {
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
  const showHistoryBtn = occupied && canViewGlobalLayoutSeatHistory();
  const historyBtnHtml = showHistoryBtn
    ? `<button type="button" class="seat-history-btn" data-seat-history="${escapeHtml(seatId)}" aria-label="배치 이력 보기" title="배치 이력">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
          </svg>
        </button>`
    : "";
  return {
    seatId,
    idAttr: "data-seat-id",
    className: seatBoxClass,
    x,
    y,
    innerHtml: `
        ${historyBtnHtml}
        <div class="seat-title">SEAT ${escapeHtml(canvasLabel)}</div>
        <div class="${personClass}">${escapeHtml(name)}</div>
      `
  };
}

function syncGlobalLayoutPcCanvas(seats) {
  const inner = GL.app?.querySelector(".canvas-inner");
  if (!inner) return false;
  const paletteMap = buildEventBoxPaletteMap(seats);
  const result = syncSeatBoxesInContainer(inner, seats, {
    getSeatId: (box) => box.getAttribute("data-seat-id"),
    buildBoxState: (s, idx) => buildGlobalSeatBoxState(s, idx, paletteMap)
  });
  if (result.rebuilt) return false;
  updateCanvasSeatTimerClasses();
  refreshGlobalLayoutAlignButtonState();
  return true;
}

export function updateCanvasSeatTimerClasses() {
  if (!GL.app) return;
  const root = GL.app.querySelector(".pc-canvas");
  if (!root) return;
  const now = Date.now();
  const seatById = buildGlobalSeatsByIdMap();
  root.querySelectorAll(".seat-box[data-seat-id]").forEach((box) => {
    const id = String(box.getAttribute("data-seat-id") || "").trim();
    const s = seatById.get(id);
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
  if (layoutIsMobile()) return;
  const waitScroll = getPcWaitScrollEl();
  const seatScroll = getPcSeatScrollEl();
  if (waitScroll) GL.waitListScrollTop = waitScroll.scrollTop;
  if (seatScroll) GL.seatListScrollTop = seatScroll.scrollTop;
}

export function restorePanelScroll() {
  if (layoutIsMobile()) return;
  const waitTop = Number(GL.waitListScrollTop) || 0;
  const seatTop = Number(GL.seatListScrollTop) || 0;
  const apply = () => {
    const waitScroll = getPcWaitScrollEl();
    const seatScroll = getPcSeatScrollEl();
    if (waitScroll) waitScroll.scrollTop = waitTop;
    if (seatScroll) seatScroll.scrollTop = seatTop;
  };
  apply();
  requestAnimationFrame(apply);
}

/** PC 우측 패널: 대기·Seat 동시 갱신 */
export function refreshGlobalLayoutPcOpsPanel() {
  if (layoutIsMobile()) return;
  renderWaiting(getCurrentTournamentWaiting());
  renderSeatPanel();
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

export { getSeatById };

function formatSeatPanelEventBoxMeta(seat = {}) {
  const { eventId, boxId } = resolveSeatEventBox(seat);
  if (!eventId && !boxId) return "";
  const card = getEventCardIdFromRecord({ id: eventId }) || eventId;
  return `카드 ${card} · Box ${boxId}`;
}

export function getDefaultEventBoxForNewSeat() {
  if (GL.urlEventId && GL.urlBoxId) return { eventId: GL.urlEventId, boxId: GL.urlBoxId };

  const se = String(sessionStorage.getItem("eventId") || "").trim();
  const sb = String(sessionStorage.getItem("boxId") || "").trim();
  if (se && sb) return { eventId: se, boxId: sb };

  const persisted = readPersistedSeatAddForm();
  if (persisted?.eventId && persisted?.boxId) {
    return { eventId: persisted.eventId, boxId: persisted.boxId };
  }

  const cachedEvents = getSeatAddEventsCache();
  if (cachedEvents.length) {
    const ev = cachedEvents[0];
    const eventId = String(ev.id || "").trim();
    const boxId = String(ev.boxId || "").trim();
    if (eventId && boxId) return { eventId, boxId };
  }

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
  return { eventId: "", boxId: "" };
}

export function renderSeats(seats = []) {
  if (!GL.app) return;
  updateGlobalLayoutMetaCounts(seats);
  if (layoutIsMobile()) {
    updateGlobalLayoutMetaCounts(GL.globalSeats);
    renderGlobalLayoutMobile({ sync: true });
    return;
  }
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

  if (syncGlobalLayoutPcCanvas(seats)) {
    const vp = GL.app.querySelector(".layout-canvas-viewport");
    const cv = GL.app.querySelector(".pc-canvas");
    if (vp && cv) applyGlobalLayoutCanvasTransform(cv);
    return;
  }

  const sorted = [...seats].sort((a, b) => (a.order || 0) - (b.order || 0));
  const paletteMap = buildEventBoxPaletteMap(sorted);
  const seatHtml = sorted.map((s, idx) => {
    const st = buildGlobalSeatBoxState(s, idx, paletteMap);
    return `
      <div class="${st.className}" data-seat-id="${escapeHtml(st.seatId)}" style="left:${st.x}px;top:${st.y}px;">
        ${st.innerHtml}
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
  updateGlobalLayoutWaitingMeta();
  if (layoutIsMobile()) {
    updateGlobalLayoutMetaCounts(GL.globalSeats);
    renderGlobalLayoutMobile({ sync: true });
    return;
  }
  const waitCol = getPcWaitColEl();
  if (!waitCol) return;
  capturePanelScroll();

  const existingList = waitCol.querySelector(".global-list");
  const existingManual = waitCol.querySelector("#manualWaitingNameInput");
  const sortedWaiting = sortWaitingForDisplay(waiting);
  const nextFp = waitingPanelFingerprint(sortedWaiting);
  if (nextFp === GL._waitingPanelFp && existingList && existingManual) {
    restorePanelScroll();
    updateGlobalMetaToolbar();
    return;
  }
  GL._waitingPanelFp = nextFp;

  const waitingRows = sortedWaiting
    .map((w) => {
      const wid = String(w.id || "");
      const pickUi = waitingRowPickClass(wid);
      const selected = pickUi.isSelected;
      const blocked = isWaitingBlocked(w);
      const startMs = getWaitingDisplayStartMs(w);
      const elapsed = Date.now() - startMs;
      const tClass = timerClass(elapsed);
      const blockCheck = canManageGlobalLayoutOps()
        ? `<label class="wait-check-slot" title="체크 시 배치 블락 + 체크 시각 기준 타이머">
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
      const deleteBtn = canManageGlobalLayoutOps()
        ? `<button class="pill-inline danger" type="button" data-delete-wid="${escapeHtml(wid)}">삭제</button>`
        : "";
      return `
    <div
      class="seat-manage-row wait-panel-row gl-panel-list-row ${selected ? "selected" : ""} ${blocked ? "is-blocked" : ""} ${pickUi.classes}"
      style="--wait-pick-color:${escapeHtml(pickUi.pickColor)}"
      data-wid="${escapeHtml(wid)}"
      data-wait-join-ms="${joinedAtMs}"
      data-block-accum-ms="${blockAccumulatedMs}"
      data-block-checked-at-ms="${blockCheckedAtMs}"
    >
      <div class="seat-manage-main seat-manage-main--oneline">
        <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
          ${blockCheck}
          <div class="seat-manage-namecol">
            <span class="seat-manage-name">${escapeHtml(w.name || w.uid || "-")}</span>
            ${buildWaitingPickBadgesHtml(wid)}
            ${blockBadge}
          </div>
        </div>
        <div class="seat-inline-actions">
          ${deleteBtn}
          <span class="time-chip ${tClass}" data-wait-start="${startMs}" data-wait-id="${escapeHtml(wid)}">${fmtElapsed(elapsed)}</span>
        </div>
      </div>
    </div>
  `;
    })
    .join("");

  const listHtml = waitingRows || `<div class="empty-panel">현재 대기자가 없습니다.</div>`;
  if (existingList && existingManual) {
    existingList.innerHTML = listHtml;
    const legend = waitCol.querySelector(".gl-operator-legend");
    const nextLegend = buildOperatorLegendHtml();
    if (legend && nextLegend) legend.outerHTML = nextLegend;
    else if (!legend && nextLegend) existingList.insertAdjacentHTML("beforebegin", nextLegend);
    restorePanelScroll();
    updateGlobalMetaToolbar();
    refreshGlobalLayoutAlignButtonState();
    return;
  }

  waitCol.innerHTML = `
    <div class="global-form single admin-only ${canManageGlobalLayoutOps() ? "" : "hidden"}">
      <input id="manualWaitingNameInput" placeholder="-" autocomplete="off" />
      <button id="addManualWaitingBtn" class="pill-inline full" type="button">+ 대기</button>
    </div>
    ${buildOperatorLegendHtml()}
    <div class="global-pc-ops-scroll" data-pc-scroll="wait">
      <div class="global-list">
        ${listHtml}
      </div>
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
  refreshGlobalLayoutAlignButtonState();
}

export function updateSeatPanelTimers() {
  const seatCol = getPcSeatColEl();
  if (!seatCol) return;
  const chips = seatCol.querySelectorAll(".time-chip[data-seat-start]");
  if (!chips.length) return;
  const now = Date.now();
  chips.forEach((chip) => {
    const start = Number(chip.getAttribute("data-seat-start") || "0");
    const elapsed = start > 0 ? Math.max(0, now - start) : 0;
    chip.textContent = fmtElapsed(elapsed);
    const cls = timerClass(elapsed);
    chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    chip.classList.add(cls);
  });
}

export function updateWaitingTimersInPanel() {
  const waitCol = getPcWaitColEl();
  if (!waitCol) return;
  const chips = waitCol.querySelectorAll(".time-chip[data-wait-start]");
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
  if (layoutIsMobile()) return;
  const seatCol = getPcSeatColEl();
  if (!seatCol) return;
  capturePanelScroll();
  const selectedWaiting = String(GL.selectedWaitingId || "").trim()
    ? getCurrentTournamentWaiting().find((w) => String(w.id || "").trim() === GL.selectedWaitingId) ||
      resolveSelectedWaitingForAssign()
    : null;
  const sorted = [...GL.globalSeats].sort((a, b) => {
    if (GL.seatSortMode === "time") return compareGlobalSeatsBySeatedTimeOldest(a, b);
    return compareSeatsByCanvasLabel(a, b);
  });
  const existingList = seatCol.querySelector(".global-list");
  const existingPicker = seatCol.querySelector("#seatAddEventPick");
  const nextSeatFp = seatPanelFingerprint(sorted);
  if (nextSeatFp === GL._seatPanelFp && existingList && existingPicker) {
    restorePanelScroll();
    updateSeatPanelTimers();
    return;
  }
  GL._seatPanelFp = nextSeatFp;

  const panelPaletteMap = buildEventBoxPaletteMap(sorted);
  const rows = sorted
    .map((s) => {
      const occupied = !isEmptyPerson(String(s.person || "").trim());
      const name = occupied ? String(s.person || "").trim() : "-";
      const isSelf = occupied && isSeatAssignedToCurrentUser(s, auth.currentUser, GL.userProfile);
      const seatId = String(s.seatId || "").trim();
      const firestoreDocId = String(s.__firestoreDocId || "").trim();
      const rowKey = getGlobalSeatRowKey(s);
      const paletteClass = getEventBoxPaletteClass(s, panelPaletteMap);
      const selectedRowClass = GL.selectedSeatIds.has(rowKey) ? "selected" : "";
      const seatedAt = getGlobalSeatSeatedAtMs(s);
      const elapsed = seatedAt ? Date.now() - seatedAt : 0;
      const tClass = timerClass(elapsed);
      const ebMeta = !occupied ? formatSeatPanelEventBoxMeta(s) : "";
      return `
      <div class="seat-manage-row gl-panel-list-row ${paletteClass} ${selectedRowClass}" data-select-seat="${escapeHtml(rowKey)}" data-firestore-doc="${escapeHtml(firestoreDocId)}">
        <div class="seat-manage-main seat-manage-main--oneline">
          <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
            <span class="seat-manage-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
            <div class="seat-manage-namecol">
              <span class="seat-manage-name ${occupied ? "" : "is-empty"} ${isSelf ? "is-self" : ""}">${escapeHtml(name)}</span>
              ${ebMeta ? `<span class="seat-manage-eb-meta muted">${escapeHtml(ebMeta)}</span>` : ""}
            </div>
          </div>
          <div class="seat-inline-actions">
            ${
              occupied
                ? `<span class="time-chip ${tClass}" data-seat-start="${seatedAt || 0}">${fmtElapsed(elapsed)}</span>`
                : `<span class="seat-manage-empty-dash">-</span>`
            }
            ${
              canManageGlobalLayoutOps() && GL.selectedWaitingId
                ? !occupied
                  ? `<button class="pill-inline" data-assign-seat="${escapeHtml(seatId)}">여기 배치</button>`
                  : `<button class="pill-inline" data-assign-seat="${escapeHtml(seatId)}">대기↔스왑</button>`
                : ``
            }
            ${canManageGlobalLayoutOps() && occupied ? `<button class="pill-inline seat-icon-btn warn" type="button" data-clear-seat="${escapeHtml(seatId)}" title="비우기" aria-label="비우기">🧹</button>` : ``}
            ${
              canManageGlobalLayoutOps()
                ? `<button class="pill-inline seat-icon-btn" type="button" data-rename-seat="${escapeHtml(seatId)}" title="수정" aria-label="수정">⚙</button>`
                : ``
            }
            ${canManageGlobalLayoutOps() ? `<button class="pill-inline seat-icon-btn danger" data-delete-seat="${escapeHtml(seatId)}" data-delete-doc="${escapeHtml(firestoreDocId)}" title="삭제" aria-label="삭제">🗑</button>` : ``}
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
  const seatAddTitle = defEb.eventId && defEb.boxId
    ? `카드 ID는 드롭다운에서 선택합니다. Box ID는 해당 카드(Firestore·기존 좌석) 기준으로 자동 채워지며 필요 시 수정할 수 있습니다. 비우면 ${defEb.eventId} / ${defEb.boxId} 사용.`
    : "index「이벤트 카드 관리」에서 오늘 운영일 카드를 저장한 뒤, 드롭다운에서 카드·Box ID를 선택하세요.";

  const seatAssignBannerHtml =
    canManageGlobalLayoutOps() && selectedWaiting
      ? `
    <div class="mobile-selection-banner layout-seat-assign-banner">
      <span class="badge sel">배치할 대기</span>
      <strong>${escapeHtml(selectedWaiting.name || "")}</strong>
    </div>`
      : "";

  const listHtml = rows || `<div class="empty-panel">전역 좌석이 없습니다.</div>`;
  if (existingList && existingPicker) {
    existingList.innerHTML = listHtml;
    const orderBtn = seatCol.querySelector("#sortSeatOrderBtn");
    const timeBtn = seatCol.querySelector("#sortSeatTimeBtn");
    if (orderBtn) orderBtn.classList.toggle("active", GL.seatSortMode === "seat");
    if (timeBtn) timeBtn.classList.toggle("active", GL.seatSortMode === "time");
    const existingBanner = seatCol.querySelector(".layout-seat-assign-banner");
    if (seatAssignBannerHtml) {
      if (existingBanner) {
        existingBanner.outerHTML = seatAssignBannerHtml.trim();
      } else {
        existingList.insertAdjacentHTML("beforebegin", seatAssignBannerHtml);
      }
    } else if (existingBanner) {
      existingBanner.remove();
    }
    restorePanelScroll();
    updateGlobalMetaToolbar();
    refreshGlobalLayoutAlignButtonState();
    if (canManageGlobalLayoutOps()) void wireSeatAddEventPicker();
    return;
  }

  seatCol.innerHTML = `
    <div class="gl-panel-seat-toolbar">
      <div
        class="seat-add-one-row global-form-seat-add admin-only ${canManageGlobalLayoutOps() ? "" : "hidden"}"
        title="${escapeHtml(seatAddTitle)}"
      >
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
            <span class="seat-add-event-trigger-text" id="seatAddEventTriggerText" aria-hidden="true">카드 선택 ▾</span>
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
      <div class="seat-sort-row">
        <button id="sortSeatOrderBtn" class="pill-inline ${GL.seatSortMode === "seat" ? "active" : ""}" type="button">Seat순</button>
        <button id="sortSeatTimeBtn" class="pill-inline ${GL.seatSortMode === "time" ? "active" : ""}" type="button" title="앉은 지 오래된 순(타이머 긴 사람이 위), 빈 좌석은 아래">시간순</button>
      </div>
    </div>
    ${seatAssignBannerHtml}
    <div class="global-pc-ops-scroll" data-pc-scroll="seat">
      <div class="global-list">
        ${listHtml}
      </div>
    </div>
  `;
  restorePanelScroll();
  updateGlobalMetaToolbar();
  refreshGlobalLayoutAlignButtonState();
  if (canManageGlobalLayoutOps()) void wireSeatAddEventPicker();
}
