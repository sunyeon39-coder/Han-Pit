import { auth } from "../firebase.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { isSeatAssignedToCurrentUser } from "../layout/layout-main-identity.js";
import { GL } from "./state.js";
import {
  escapeHtml,
  isEmptyPerson,
  seatCanvasDigitsOnly,
  getGlobalSeatRowKey,
  compareGlobalSeatsBySeatedTimeOldest,
  getGlobalSeatSeatedAtMs,
  toMillis,
  fmtElapsed,
  timerClass
} from "./utils.js";
import {
  applyOptimisticWaitingBlockRow,
  applyWaitingBlockLocal,
  getWaitingDisplayStartMs,
  isWaitingBlocked,
  getCurrentTournamentWaiting,
  partitionWaitingForMobileDisplay,
  resolveSelectedWaitingForAssign
} from "./waiting.js";
import {
  buildOperatorLegendHtml,
  buildWaitingPickBadgesHtml,
  waitingRowPickClass,
  setWaitingRowSelection,
  syncSelectedWaitingFromMyOperatorPick
} from "./waiting-picks.js";
import { getEventBoxPaletteClass, buildEventBoxPaletteMap } from "./event-box-palette.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import { resolveSeatEventBox } from "./utils.js";
import { openGlobalMobileSeatAddModal } from "./mobile-seat-add-modal.js";
import {
  updateGlobalLayoutMetaCounts,
  updateGlobalLayoutWaitingMeta,
  syncGlobalLayoutMetaPills
} from "./meta-ui.js";
import { invalidateWaitingPanelFingerprint } from "./panel-ui.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { tryOpenSeatHistoryFromPersonClick } from "./seat-history-modal.js";

function formatMobileSeatEventBoxMeta(seat = {}) {
  const { eventId, boxId } = resolveSeatEventBox(seat);
  if (!eventId && !boxId) return "";
  const card = getEventCardIdFromRecord({ id: eventId }) || eventId;
  return `카드 ${card} · Box ${boxId}`;
}

let firestoreOpsPromise = null;
function loadFirestoreOps() {
  if (!firestoreOpsPromise) {
    firestoreOpsPromise = import("./firestore-ops.js");
  }
  return firestoreOpsPromise;
}

const GLOBAL_MOBILE_SEAT_DOUBLE_MS = 350;

/** 모바일 Seat: 앉은 지 오래된 순(빈 좌석은 아래), PC Seat순 토글 무시 */
function getSortedSeatsForMobile() {
  return [...GL.globalSeats].sort(compareGlobalSeatsBySeatedTimeOldest);
}

function setMobileSeatSelection(seatId = "") {
  const sid = String(seatId || "").trim();
  GL.selectedSeatIds.clear();
  if (sid) GL.selectedSeatIds.add(sid);
}

function getGlobalLayoutMobileScrollEl() {
  return GL.app?.querySelector(".global-layout-mobile") || null;
}

function captureGlobalLayoutMobileScroll() {
  const el = getGlobalLayoutMobileScrollEl();
  GL.mobileListScrollTop = el ? el.scrollTop : 0;
}

function restoreGlobalLayoutMobileScroll() {
  const top = Number(GL.mobileListScrollTop) || 0;
  const apply = () => {
    const el = getGlobalLayoutMobileScrollEl();
    if (el) el.scrollTop = top;
  };
  apply();
  requestAnimationFrame(apply);
}

function buildMobileSeatByKeyMap() {
  const map = new Map();
  for (const seat of GL.globalSeats || []) {
    map.set(getGlobalSeatRowKey(seat), seat);
    const sid = String(seat?.seatId || "").trim();
    if (sid) map.set(sid, seat);
  }
  return map;
}

function resolveMobileSelectedWaiting(waiting = getCurrentTournamentWaiting()) {
  const selId = String(GL.selectedWaitingId || "").trim();
  if (!selId) return null;
  return (
    waiting.find((w) => String(w.id || "").trim() === selId) || resolveSelectedWaitingForAssign()
  );
}

function buildMobileAssignSeatButtonHtml(seatId, selectedWaiting, occupied) {
  const action = occupied ? "스왑" : "배치";
  const assignLabel = escapeHtml(`${selectedWaiting.name || ""} 이 Seat에 ${action}`);
  return `<button type="button" class="mobile-pill-btn primary mobile-pill-btn--assign-seat" data-mobile-assign="${escapeHtml(seatId)}" aria-label="${assignLabel}">${action}</button>`;
}

function mobileLayoutStructureFingerprint() {
  const seats = getSortedSeatsForMobile();
  const waiting = getCurrentTournamentWaiting();
  const { normal, blocked } = partitionWaitingForMobileDisplay(waiting);
  const seatPart = seats
    .map((s) => {
      const occupied = !isEmptyPerson(String(s.person || "").trim());
      return `${getGlobalSeatRowKey(s)}:${occupied ? 1 : 0}`;
    })
    .join(",");
  return [
    GL.selectedWaitingId || "",
    seatPart,
    normal.map((w) => String(w.id || "")).join(","),
    blocked.map((w) => String(w.id || "")).join(","),
    blocked.length > 0 ? "1" : "0"
  ].join("|");
}

function syncMobileSelectionBanner(seatCard, selectedWaiting) {
  if (!seatCard) return;
  const existing = seatCard.querySelector(".mobile-selection-banner");
  if (!selectedWaiting) {
    existing?.remove();
    return;
  }
  const html = `
      <div class="mobile-selection-banner">
        <span class="badge sel">배치할 대기</span>
        <strong>${escapeHtml(selectedWaiting.name || selectedWaiting.uid || "-")}</strong>
      </div>
    `;
  if (existing) {
    existing.outerHTML = html.trim();
  } else {
    const head = seatCard.querySelector(".mobile-section-head");
    head?.insertAdjacentHTML("afterend", html);
  }
}

function syncMobileSeatRow(row, seat, selectedWaiting, paletteMap) {
  const seatId = String(seat.seatId || "").trim();
  const rowKey = getGlobalSeatRowKey(seat);
  const occupied = !isEmptyPerson(String(seat.person || "").trim());
  const name = occupied ? String(seat.person || "").trim() : "비어있음";
  const isSel = GL.selectedSeatIds.has(seatId);
  const isSelf = occupied && isSeatAssignedToCurrentUser(seat, auth.currentUser, GL.userProfile);
  const paletteClass = getEventBoxPaletteClass(seat, paletteMap);
  const seatedAt = occupied ? getGlobalSeatSeatedAtMs(seat) || Date.now() : 0;
  const elapsed = seatedAt ? Date.now() - seatedAt : 0;
  const tClass = occupied ? timerClass(elapsed) : "";

  row.className = `mobile-seat-row compact ${paletteClass} ${isSel ? "selected" : ""}`;
  const personEl = row.querySelector(".mobile-seat-person");
  if (personEl) {
    personEl.textContent = name;
    personEl.classList.toggle("is-empty", !occupied);
    personEl.classList.toggle("is-self", isSelf);
  }
  const numEl = row.querySelector(".mobile-seat-num");
  if (numEl) numEl.textContent = seatCanvasDigitsOnly(seat.label, seat.no);

  const clearBtn = row.querySelector("[data-clear-seat]");
  if (occupied && !clearBtn) {
    const actions = row.querySelector(".mobile-seat-inline-actions");
    actions?.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="mobile-pill-btn warn" data-clear-seat="${escapeHtml(seatId)}">비우기</button>`
    );
  } else if (!occupied) {
    clearBtn?.remove();
  }

  let assignBtn = row.querySelector("[data-mobile-assign]");
  if (selectedWaiting && canManageGlobalLayoutOps()) {
    const actions = row.querySelector(".mobile-seat-inline-actions");
    const html = buildMobileAssignSeatButtonHtml(seatId, selectedWaiting, occupied);
    if (!assignBtn) {
      actions?.insertAdjacentHTML("beforeend", html);
    } else {
      const wantLabel = occupied ? "스왑" : "배치";
      if (assignBtn.textContent.trim() !== wantLabel) {
        assignBtn.outerHTML = html.trim();
      }
    }
  } else if (assignBtn) {
    assignBtn.remove();
  }

  const chip = row.querySelector(".mobile-seat-right .time-chip");
  const dash = row.querySelector(".mobile-seat-right .mobile-empty-dash");
  if (occupied) {
    dash?.remove();
    if (chip) {
      chip.textContent = fmtElapsed(elapsed);
      chip.className = `time-chip ${tClass}`;
    }
  } else if (!dash) {
    chip?.remove();
    row.querySelector(".mobile-seat-right")?.insertAdjacentHTML(
      "beforeend",
      `<span class="mobile-empty-dash">—</span>`
    );
  }
}

function syncMobileWaitRow(row, w) {
  const wid = String(w.id || "");
  const pickUi = waitingRowPickClass(wid);
  const blocked = isWaitingBlocked(w);
  const startMs = getWaitingDisplayStartMs(w);
  const elapsed = Date.now() - startMs;
  const tClass = timerClass(elapsed);

  row.className = `mobile-seat-row mobile-wait-row compact ${pickUi.isSelected ? "selected" : ""} ${blocked ? "is-blocked" : ""} ${pickUi.classes}`;
  row.style.setProperty("--wait-pick-color", pickUi.pickColor);
  const nameEl = row.querySelector(".mobile-seat-person");
  if (nameEl) nameEl.textContent = String(w.name || w.uid || "-");
  const cb = row.querySelector(".wait-block-check");
  if (cb) cb.checked = blocked;
  let badge = row.querySelector(".wait-block-badge");
  if (blocked && !badge && nameEl?.parentElement) {
    badge = document.createElement("span");
    badge.className = "wait-block-badge";
    badge.textContent = "BLOCK";
    nameEl.insertAdjacentElement("afterend", badge);
  } else if (!blocked) {
    badge?.remove();
  }
  const chip = row.querySelector(".time-chip[data-wait-start]");
  if (chip) {
    chip.setAttribute("data-wait-start", String(startMs));
    chip.textContent = fmtElapsed(elapsed);
    chip.className = `time-chip ${tClass}`;
  }
}

function trySyncGlobalLayoutMobile() {
  const root = getGlobalLayoutMobileScrollEl();
  if (!root) return false;

  const nextFp = mobileLayoutStructureFingerprint();
  if (root.getAttribute("data-mobile-structure-fp") !== nextFp) return false;

  captureGlobalLayoutMobileScroll();
  updateGlobalLayoutMetaCounts(GL.globalSeats);
  syncGlobalLayoutMetaPills(root);
  updateGlobalLayoutWaitingMeta();

  const waiting = getCurrentTournamentWaiting();
  const selectedWaiting = resolveMobileSelectedWaiting(waiting);
  const paletteMap = buildEventBoxPaletteMap(GL.globalSeats);
  const seatByKey = buildMobileSeatByKeyMap();
  const waitById = new Map(waiting.map((w) => [String(w.id || ""), w]));

  const cards = root.querySelectorAll(".card");
  const seatCard = cards[0] || null;
  syncMobileSelectionBanner(seatCard, selectedWaiting);

  root.querySelectorAll("[data-mobile-seat]").forEach((row) => {
    const key = String(row.getAttribute("data-mobile-seat") || "").trim();
    const seat = seatByKey.get(key);
    if (seat) syncMobileSeatRow(row, seat, selectedWaiting, paletteMap);
  });

  root.querySelectorAll("[data-mobile-wait]").forEach((row) => {
    const wid = String(row.getAttribute("data-mobile-wait") || "").trim();
    const w = waitById.get(wid);
    if (w) syncMobileWaitRow(row, w);
  });

  restoreGlobalLayoutMobileScroll();
  return true;
}

let mobileEventsWired = false;

export function wireGlobalLayoutMobileEventsOnce() {
  if (mobileEventsWired || !GL.app) return;
  mobileEventsWired = true;

  const fullRender = () => renderGlobalLayoutMobile({ forceFull: true });

  GL.app.addEventListener("click", async (e) => {
    if (!layoutIsMobile()) return;

    if (e.target.closest("#globalMobileAddSeatInline")) {
      void openGlobalMobileSeatAddModal();
      return;
    }

    if (e.target.closest("#globalMobileAddWaitingInline")) {
      const name = prompt("대기자 이름", "");
      if (name === null) return;
      try {
        const { addManualWaitingByName } = await loadFirestoreOps();
        await addManualWaitingByName(name);
      } catch (err) {
        console.error("addManualWaitingByName error:", err);
        alert("대기 추가에 실패했습니다.");
      }
      return;
    }

    const assignBtn = e.target.closest("[data-mobile-assign]");
    if (assignBtn) {
      e.stopPropagation();
      syncSelectedWaitingFromMyOperatorPick();
      const sid = String(assignBtn.getAttribute("data-mobile-assign") || "").trim();
      if (!String(GL.selectedWaitingId || "").trim() || !sid) return;
      try {
        const { assignSelectedWaitingToSeat } = await loadFirestoreOps();
        await assignSelectedWaitingToSeat(sid);
        fullRender();
      } catch (err) {
        console.error("mobile assign button error:", err);
        alert("대기 배치에 실패했습니다.");
        fullRender();
      }
      return;
    }

    const delSeatBtn = e.target.closest("[data-del-seat]");
    if (delSeatBtn) {
      e.stopPropagation();
      const sid = String(delSeatBtn.getAttribute("data-del-seat") || "").trim();
      const docId = String(delSeatBtn.getAttribute("data-del-doc") || "").trim();
      if ((!sid && !docId) || !confirm("이 좌석을 삭제하시겠습니까?")) return;
      try {
        const { deleteGlobalSeat } = await loadFirestoreOps();
        await deleteGlobalSeat(sid, { firestoreDocId: docId });
        if (sid) GL.selectedSeatIds.delete(sid);
      } catch (err) {
        console.error("mobile deleteGlobalSeat error:", err);
        alert("좌석 삭제에 실패했습니다.");
      }
      fullRender();
      return;
    }

    const clearBtn = e.target.closest("[data-clear-seat]");
    if (clearBtn) {
      e.stopPropagation();
      const sid = String(clearBtn.getAttribute("data-clear-seat") || "").trim();
      if (!sid) return;
      try {
        const { clearSeat } = await loadFirestoreOps();
        await clearSeat(sid);
      } catch (err) {
        console.error("mobile clearSeat error:", err);
        fullRender();
      }
      return;
    }

    const renameBtn = e.target.closest("[data-rename-seat]");
    if (renameBtn) {
      e.stopPropagation();
      const sid = String(renameBtn.getAttribute("data-rename-seat") || "").trim();
      if (!sid) return;
      const { openSeatEditModal } = await import("./seat-edit-modal.js");
      openSeatEditModal(sid);
      return;
    }

    const delWaitBtn = e.target.closest("[data-del-w]");
    if (delWaitBtn) {
      e.stopPropagation();
      const wid = String(delWaitBtn.getAttribute("data-del-w") || "").trim();
      if (!wid || !confirm("대기자를 삭제하시겠습니까?")) return;
      const { removeManualWaiting } = await loadFirestoreOps();
      await removeManualWaiting(wid);
      fullRender();
      return;
    }

    const waitRow = e.target.closest("[data-mobile-wait]");
    if (
      waitRow &&
      !e.target.closest("[data-del-w]") &&
      !e.target.closest(".wait-check-slot, input.wait-block-check")
    ) {
      const wid = String(waitRow.getAttribute("data-mobile-wait") || "").trim();
      if (!wid) return;
      setWaitingRowSelection(wid);
      fullRender();
      return;
    }

    const seatRow = e.target.closest("[data-mobile-seat]");
    if (
      seatRow &&
      !e.target.closest("[data-del-seat]") &&
      !e.target.closest("[data-mobile-assign]") &&
      !e.target.closest("[data-clear-seat]") &&
      !e.target.closest("[data-rename-seat]")
    ) {
      const sid = String(seatRow.getAttribute("data-mobile-seat") || "").trim();
      if (!sid) return;
      if (tryOpenSeatHistoryFromPersonClick(e, sid)) return;
      const seat = GL.globalSeats.find((x) => getGlobalSeatRowKey(x) === sid || String(x.seatId || "").trim() === sid);
      const occupied = seat && !isEmptyPerson(String(seat.person || "").trim());
      const now = Date.now();

      if (GL.selectedWaitingId) {
        syncSelectedWaitingFromMyOperatorPick();
        if (!String(GL.selectedWaitingId || "").trim()) {
          fullRender();
          return;
        }
        setMobileSeatSelection(sid);
        try {
          const { assignSelectedWaitingToSeat } = await loadFirestoreOps();
          await assignSelectedWaitingToSeat(sid);
          fullRender();
        } catch (err) {
          if (String(err?.message || "").includes("same_person_noop")) {
            alert("이미 이 Seat에 있는 사람입니다. 다른 Seat를 선택하세요.");
          } else if (String(err?.message || "").includes("waiting_blocked")) {
            alert("BLOCK 체크된 대기자는 배치할 수 없습니다.");
          } else if (String(err?.message || "").includes("waiting_not_found")) {
            alert("해당 대기자가 이미 처리되었습니다.");
          } else if (String(err?.message || "").includes("seat_not_found")) {
            alert("Seat 정보를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.");
          } else {
            console.error("mobile assign error:", err);
            alert("대기 배치에 실패했습니다.");
          }
          fullRender();
        }
        return;
      }

      if (occupied) {
        if (GL.lastSeatTapId === sid && now - Number(GL.lastSeatTapAt || 0) < GLOBAL_MOBILE_SEAT_DOUBLE_MS) {
          GL.lastSeatTapAt = 0;
          GL.lastSeatTapId = "";
          try {
            const { clearSeat } = await loadFirestoreOps();
            setMobileSeatSelection("");
            await clearSeat(sid);
          } catch (err) {
            console.error("mobile clearSeat error:", err);
            fullRender();
          }
          return;
        }
        GL.lastSeatTapAt = now;
        GL.lastSeatTapId = sid;
        setMobileSeatSelection(sid);
        fullRender();
        return;
      }

      GL.lastSeatTapAt = now;
      GL.lastSeatTapId = sid;
      setMobileSeatSelection(sid);
      fullRender();
    }
  });

  GL.app.addEventListener("change", async (e) => {
    if (!layoutIsMobile()) return;
    const cb = e.target.closest("[data-mobile-block-w]");
    if (!cb) return;
    e.stopPropagation();
    if (!canManageGlobalLayoutOps()) {
      cb.checked = !cb.checked;
      alert("운영 권한이 필요합니다.");
      return;
    }
    const wid = String(cb.getAttribute("data-mobile-block-w") || "").trim();
    if (!wid) return;
    const nextChecked = !!cb.checked;
    applyWaitingBlockLocal(wid, nextChecked);
    applyOptimisticWaitingBlockRow(cb.closest("[data-mobile-wait]"), nextChecked);
    invalidateWaitingPanelFingerprint();
    updateGlobalLayoutWaitingMeta();
    cb.disabled = true;
    try {
      const { setWaitingBlocked } = await loadFirestoreOps();
      await setWaitingBlocked(wid, nextChecked);
    } catch (err) {
      console.error("mobile setWaitingBlocked error:", err);
      fullRender();
    } finally {
      cb.disabled = false;
    }
  });
}

/** 1초 타이머용 — DOM 전체를 다시 그리지 않고 시간 칩만 갱신 (스크롤 유지) */
export function refreshGlobalLayoutMobileTimers() {
  if (!GL.app || !layoutIsMobile()) return;
  const root = getGlobalLayoutMobileScrollEl();
  if (!root) {
    renderGlobalLayoutMobile();
    return;
  }

  const now = Date.now();
  const waiting = getCurrentTournamentWaiting();
  const seatByKey = buildMobileSeatByKeyMap();
  const waitById = new Map(waiting.map((w) => [String(w.id || ""), w]));

  root.querySelectorAll(".mobile-seat-row[data-mobile-seat]").forEach((row) => {
    const sid = String(row.getAttribute("data-mobile-seat") || "").trim();
    const seat = seatByKey.get(sid);
    if (!seat) return;
    const occupied = !isEmptyPerson(String(seat.person || "").trim());
    const chip = row.querySelector(".mobile-seat-right .time-chip");
    if (!occupied || !chip) return;
    const seatedAt = getGlobalSeatSeatedAtMs(seat);
    const elapsed = seatedAt ? now - seatedAt : 0;
    const tClass = timerClass(elapsed);
    chip.textContent = fmtElapsed(elapsed);
    chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    chip.classList.add(tClass);
  });

  root.querySelectorAll(".mobile-wait-row[data-mobile-wait]").forEach((row) => {
    const wid = String(row.getAttribute("data-mobile-wait") || "").trim();
    const w = waitById.get(wid);
    if (!w) return;
    const chip = row.querySelector(".time-chip[data-wait-start]");
    if (!chip) return;
    const startMs = getWaitingDisplayStartMs(w);
    const elapsed = Math.max(0, now - startMs);
    const tClass = timerClass(elapsed);
    chip.setAttribute("data-wait-start", String(startMs));
    chip.textContent = fmtElapsed(elapsed);
    chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
    chip.classList.add(tClass);
  });

  updateGlobalLayoutWaitingMeta();
  syncGlobalLayoutMetaPills(root);
}

export function renderGlobalLayoutMobile(options = {}) {
  if (!GL.app || !layoutIsMobile()) return;
  if (!options.forceFull && options.sync !== false && trySyncGlobalLayoutMobile()) return;

  captureGlobalLayoutMobileScroll();
  updateGlobalLayoutMetaCounts(GL.globalSeats);

  const wrap = document.createElement("div");
  wrap.className = "mobile global-layout-mobile";

  const waiting = getCurrentTournamentWaiting();
  const selectedWaiting = resolveMobileSelectedWaiting(waiting);
  const paletteMap = buildEventBoxPaletteMap(GL.globalSeats);

  wrap.innerHTML = `
    <div class="global-mobile-meta">
      <span class="hint-pill" data-meta="seat">${escapeHtml(GL.seatCountEl?.textContent || "SEAT: 0")}</span>
      <span class="hint-pill" data-meta="assigned">${escapeHtml(GL.assignedCountEl?.textContent || "ASSIGNED: 0")}</span>
      <span class="hint-pill" data-meta="wait">${escapeHtml(GL.waitingCountEl?.textContent || "WAIT: 0")}</span>
      <span class="hint-pill hint-pill--block" data-meta="block">${escapeHtml(GL.blockedCountEl?.textContent || "BLOCK: 0")}</span>
    </div>
  `;

  const seatCard = document.createElement("div");
  seatCard.className = "card";
  seatCard.innerHTML = `
    <div class="mobile-section-head">
      <h3>Seat</h3>
      <button id="globalMobileAddSeatInline" class="btn primary" type="button">+ Seat 추가</button>
    </div>
  `;

  if (selectedWaiting) {
    seatCard.innerHTML += `
      <div class="mobile-selection-banner">
        <span class="badge sel">배치할 대기</span>
        <strong>${escapeHtml(selectedWaiting.name || selectedWaiting.uid || "-")}</strong>
      </div>
    `;
  }

  const seats = getSortedSeatsForMobile();
  if (!seats.length) {
    seatCard.innerHTML += `<div class="row"><div>Seat</div><div class="muted">없음</div></div>`;
  } else {
    seats.forEach((s) => {
      const seatId = String(s.seatId || "").trim();
      const firestoreDocId = String(s.__firestoreDocId || "").trim();
      const rowKey = getGlobalSeatRowKey(s);
      const occupied = !isEmptyPerson(String(s.person || "").trim());
      const name = occupied ? String(s.person || "").trim() : "비어있음";
      const isSel = GL.selectedSeatIds.has(seatId);
      const isSelf = occupied && isSeatAssignedToCurrentUser(s, auth.currentUser, GL.userProfile);
      const paletteClass = getEventBoxPaletteClass(s, paletteMap);
      const seatedAt = occupied ? getGlobalSeatSeatedAtMs(s) || Date.now() : 0;
      const elapsed = seatedAt ? Date.now() - seatedAt : 0;
      const tClass = occupied ? timerClass(elapsed) : "";
      const ebMeta = occupied ? "" : formatMobileSeatEventBoxMeta(s);
      seatCard.innerHTML += `
        <div class="mobile-seat-row compact ${paletteClass} ${isSel ? "selected" : ""}" data-mobile-seat="${escapeHtml(rowKey)}" data-firestore-doc="${escapeHtml(firestoreDocId)}">
          <div class="mobile-seat-mainline">
            <div class="mobile-seat-name-cluster">
              <span class="mobile-seat-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
              <div class="mobile-seat-person ${occupied ? "" : "is-empty"} ${isSelf ? "is-self" : ""}">${escapeHtml(name)}</div>
              ${ebMeta ? `<div class="mobile-seat-eb-meta">${escapeHtml(ebMeta)}</div>` : ""}
            </div>
            <div class="mobile-seat-inline-actions">
              ${
                occupied
                  ? `<button type="button" class="mobile-pill-btn warn" data-clear-seat="${escapeHtml(seatId)}">비우기</button>`
                  : ""
              }
              <button type="button" class="mobile-pill-btn" data-rename-seat="${escapeHtml(seatId)}">수정</button>
              <button type="button" class="mobile-pill-btn danger" data-del-seat="${escapeHtml(seatId)}" data-del-doc="${escapeHtml(firestoreDocId)}">삭제</button>
              ${
                selectedWaiting && canManageGlobalLayoutOps()
                  ? buildMobileAssignSeatButtonHtml(seatId, selectedWaiting, occupied)
                  : ""
              }
            </div>
            <div class="mobile-seat-right">
              ${
                occupied
                  ? `<span class="time-chip ${tClass}">${escapeHtml(fmtElapsed(elapsed))}</span>`
                  : `<span class="mobile-empty-dash">—</span>`
              }
            </div>
          </div>
        </div>
      `;
    });
  }

  const appendMobileWaitRowHtml = (w) => {
    const wid = String(w.id || "");
    const pickUi = waitingRowPickClass(wid);
    const selected = pickUi.isSelected;
    const blocked = isWaitingBlocked(w);
    const startMs = getWaitingDisplayStartMs(w);
    const elapsed = Date.now() - startMs;
    const tClass = timerClass(elapsed);
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
    return `
        <div
          class="mobile-seat-row mobile-wait-row compact ${selected ? "selected" : ""} ${blocked ? "is-blocked" : ""} ${pickUi.classes}"
          style="--wait-pick-color:${escapeHtml(pickUi.pickColor)}"
          data-mobile-wait="${escapeHtml(wid)}"
          data-wait-join-ms="${joinedAtMs}"
          data-block-accum-ms="${blockAccumulatedMs}"
          data-block-checked-at-ms="${blockCheckedAtMs}"
        >
          <div class="mobile-seat-mainline">
            <div class="mobile-seat-name-cluster">
              <label class="wait-check-slot" title="체크 시 배치 블락">
                <input type="checkbox" class="wait-block-check" data-mobile-block-w="${escapeHtml(wid)}" ${blocked ? "checked" : ""} />
              </label>
              <div class="mobile-seat-person">${escapeHtml(w.name || w.uid || "-")}</div>
              ${buildWaitingPickBadgesHtml(wid)}
              ${blocked ? `<span class="wait-block-badge">BLOCK</span>` : ""}
            </div>
            <div class="mobile-seat-inline-actions">
              <button type="button" class="mobile-pill-btn danger" data-del-w="${escapeHtml(wid)}">삭제</button>
            </div>
            <div class="mobile-seat-right">
              <span class="time-chip ${tClass}" data-wait-start="${startMs}">${escapeHtml(fmtElapsed(elapsed))}</span>
            </div>
          </div>
        </div>
      `;
  };

  const waitCard = document.createElement("div");
  waitCard.className = "card";
  waitCard.innerHTML = `
    <div class="mobile-section-head">
      <h3>대기</h3>
      <button id="globalMobileAddWaitingInline" class="btn primary" type="button">+ 대기 추가</button>
    </div>
    ${buildOperatorLegendHtml()}
  `;

  const { normal: normalWaiting, blocked: blockedWaiting } = partitionWaitingForMobileDisplay(waiting);

  if (!normalWaiting.length && !blockedWaiting.length) {
    waitCard.innerHTML += `<div class="row"><div>대기</div><div class="muted">없음</div></div>`;
  } else {
    if (normalWaiting.length) {
      if (blockedWaiting.length) {
        waitCard.innerHTML += `<div class="mobile-wait-group-label">배치 가능</div>`;
      }
      normalWaiting.forEach((w) => {
        waitCard.innerHTML += appendMobileWaitRowHtml(w);
      });
    }
    if (blockedWaiting.length) {
      waitCard.innerHTML += `<div class="mobile-wait-group-label mobile-wait-group-label--block">BLOCK</div>`;
      blockedWaiting.forEach((w) => {
        waitCard.innerHTML += appendMobileWaitRowHtml(w);
      });
    }
  }

  wrap.append(seatCard, waitCard);
  GL.app.innerHTML = "";
  GL.app.appendChild(wrap);
  GL.app.classList.remove("with-panel");
  wrap.setAttribute("data-mobile-structure-fp", mobileLayoutStructureFingerprint());
  restoreGlobalLayoutMobileScroll();
  wireGlobalLayoutMobileEventsOnce();
}
