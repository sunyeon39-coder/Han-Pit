import { GL } from "./state.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import {
  getSeatById,
  renderSeats,
  renderSeatPanel,
  renderWaiting,
  setPanelOpen
} from "./panel-ui.js";
import { getCurrentTournamentWaiting } from "./waiting.js";
import {
  saveSeatPosition,
  assignSelectedWaitingToSeat,
  clearSeat,
  deleteGlobalSeat,
  addGlobalSeat,
  addManualWaiting,
  removeManualWaiting,
  undoLastGlobalAction
} from "./firestore-ops.js";
import { initGlobalSeatEditModal, openSeatEditModal } from "./seat-edit-modal.js";
import { isEmptyPerson } from "./utils.js";

function isMultiSelectPointer(e) {
  return !!(e && (e.ctrlKey || e.metaKey));
}

function findSeatBoxEl(innerRoot, seatId) {
  const sid = String(seatId || "").trim();
  if (!sid || !innerRoot) return null;
  return (
    Array.from(innerRoot.querySelectorAll(".seat-box[data-seat-id]")).find(
      (node) => String(node.getAttribute("data-seat-id") || "").trim() === sid
    ) || null
  );
}

function openGlobalMobileSeatAddFlow() {
  GL.activeTab = "seat";
  setPanelOpen(true);
  GL.mobileSheet?.classList.remove("open");
  renderSeatPanel();
  requestAnimationFrame(() => document.getElementById("seatLabelInput")?.focus());
}

function openGlobalMobileWaitingAddFlow() {
  GL.activeTab = "wait";
  setPanelOpen(true);
  GL.mobileSheet?.classList.remove("open");
  renderWaiting(getCurrentTournamentWaiting());
  requestAnimationFrame(() => document.getElementById("manualWaitingNameInput")?.focus());
}

/** 관리자 로그인 후 하단 시트 버튼 표시 등 */
export function syncGlobalLayoutMobileChrome() {
  const show = !!GL.isAdminUser;
  if (GL.mobileAddSeatBtn) GL.mobileAddSeatBtn.style.display = show ? "" : "none";
  if (GL.mobileAddWaitingBtn) GL.mobileAddWaitingBtn.style.display = show ? "" : "none";
}

function applyCanvasSeatSelectionClick(seatId, multi) {
  const sid = String(seatId || "").trim();
  if (!sid) return;
  if (multi) {
    if (GL.selectedSeatIds.has(sid)) GL.selectedSeatIds.delete(sid);
    else GL.selectedSeatIds.add(sid);
    return;
  }
  if (GL.selectedSeatIds.size === 1 && GL.selectedSeatIds.has(sid)) {
    GL.selectedSeatIds.clear();
  } else {
    GL.selectedSeatIds.clear();
    GL.selectedSeatIds.add(sid);
  }
}

export function bindGlobalLayoutEventHandlers() {
  initGlobalSeatEditModal();

  GL.backBtn?.addEventListener("click", () => {
    location.href = `./index.html?tournamentId=${encodeURIComponent(GL.tournamentId)}`;
  });

  document.getElementById("metaStats")?.addEventListener("click", async (e) => {
    if (!GL.isAdminUser || GL.activeTab !== "seat") return;
    if (e.target.closest("#globalUndoToolbarBtn")) {
      const btn = e.target.closest("#globalUndoToolbarBtn");
      if (!GL.lastGlobalUndo || btn?.disabled) return;
      await undoLastGlobalAction();
    }
  });

  GL.panelContent?.addEventListener("click", async (e) => {
    if (!GL.isAdminUser) return;

    if (e.target.closest("#addSeatToolbarBtn")) {
      try {
        await addGlobalSeat();
        renderSeatPanel();
      } catch (err) {
        console.error("addGlobalSeat error:", err);
        if (String(err?.code || "").includes("permission-denied")) {
          alert("좌석 생성 권한이 없습니다. Firestore Rules(global_seats) 배포를 확인해주세요.");
        } else {
          alert("좌석 생성에 실패했습니다.");
        }
      }
      return;
    }

    const addWaitBtn = e.target.closest("#addManualWaitingBtn");
    if (addWaitBtn) {
      try {
        await addManualWaiting();
      } catch (err) {
        console.error("addManualWaiting error:", err);
        alert("대기 추가에 실패했습니다.");
      }
      return;
    }

    const sortSeatOrderBtn = e.target.closest("#sortSeatOrderBtn");
    if (sortSeatOrderBtn) {
      GL.seatSortMode = "seat";
      renderSeatPanel();
      return;
    }
    const sortSeatTimeBtn = e.target.closest("#sortSeatTimeBtn");
    if (sortSeatTimeBtn) {
      GL.seatSortMode = "time";
      renderSeatPanel();
      return;
    }

    const renameSeatBtn = e.target.closest("[data-rename-seat]");
    if (renameSeatBtn) {
      const sid = String(renameSeatBtn.getAttribute("data-rename-seat") || "");
      if (!sid) return;
      openSeatEditModal(sid);
      return;
    }

    const clearSeatBtn = e.target.closest("[data-clear-seat]");
    if (clearSeatBtn) {
      const sid = String(clearSeatBtn.getAttribute("data-clear-seat") || "").trim();
      if (!sid) return;
      const seat = getSeatById(sid);
      if (!seat || isEmptyPerson(String(seat.person || "").trim())) return;
      if (!confirm("이 Seat에서 사람을 뺄까요?")) return;
      try {
        await clearSeat(sid);
        renderSeats(GL.globalSeats);
        if (GL.activeTab === "seat") renderSeatPanel();
      } catch (err) {
        console.error("clearSeat error:", err);
        alert("Seat 비우기에 실패했습니다.");
      }
      return;
    }

    const assignBtn = e.target.closest("[data-assign-seat]");
    if (assignBtn) {
      if (!String(GL.selectedWaitingId || "").trim()) return;
      const sid = String(assignBtn.getAttribute("data-assign-seat") || "");
      try {
        await assignSelectedWaitingToSeat(sid);
      } catch (err) {
        if (String(err?.message || "").includes("same_person_noop")) {
          alert("이미 그 Seat에 있는 사람입니다.");
        } else if (String(err?.message || "").includes("waiting_not_found")) {
          alert("해당 대기자가 이미 처리되었습니다.");
        } else {
          console.error("assignSelectedWaitingToSeat error:", err);
          alert("대기 배치에 실패했습니다.");
        }
      }
      return;
    }

    const deleteSeatBtn = e.target.closest("[data-delete-seat]");
    if (deleteSeatBtn) {
      const sid = String(deleteSeatBtn.getAttribute("data-delete-seat") || "");
      if (!sid) return;
      if (!confirm("이 좌석을 삭제하시겠습니까?")) return;
      try {
        await deleteGlobalSeat(sid);
        if (GL.activeTab === "seat") renderSeatPanel();
      } catch (err) {
        console.error("deleteGlobalSeat error:", err);
        alert("좌석 삭제에 실패했습니다.");
      }
      return;
    }

    const selectSeatRow = e.target.closest("[data-select-seat]");
    if (
      selectSeatRow &&
      !e.target.closest("[data-assign-seat],[data-clear-seat],[data-delete-seat],[data-rename-seat]")
    ) {
      const sid = String(selectSeatRow.getAttribute("data-select-seat") || "");
      if (sid) {
        applyCanvasSeatSelectionClick(sid, isMultiSelectPointer(e));
        renderSeatPanel();
        renderSeats(GL.globalSeats);
      }
      return;
    }

    const deleteWaitBtn = e.target.closest("[data-delete-wid]");
    if (deleteWaitBtn) {
      const widToDelete = String(deleteWaitBtn.getAttribute("data-delete-wid") || "");
      if (!widToDelete) return;
      if (!confirm("대기자를 삭제하시겠습니까?")) return;
      try {
        await removeManualWaiting(widToDelete);
        renderWaiting(getCurrentTournamentWaiting());
      } catch (err) {
        console.error("removeManualWaiting error:", err);
        alert("대기자 삭제에 실패했습니다.");
      }
      return;
    }

    const row = e.target.closest("[data-wid]");
    if (!row) return;
    const wid = String(row.getAttribute("data-wid") || "");
    if (!wid) return;
    const togglingOff = GL.selectedWaitingId === wid;
    GL.selectedWaitingId = togglingOff ? "" : wid;

    if (GL.selectedWaitingId) GL.selectedSeatIds.clear();
    renderWaiting(getCurrentTournamentWaiting());
  });

  GL.panelContent?.addEventListener("dblclick", async (e) => {
    if (!GL.isAdminUser) return;
    const row = e.target.closest("[data-select-seat]");
    if (!row) return;
    const seatId = String(row.getAttribute("data-select-seat") || "").trim();
    if (!seatId) return;
    const seat = getSeatById(seatId);
    if (!seat) return;
    if (isEmptyPerson(String(seat.person || "").trim())) return;
    try {
      await clearSeat(seatId);
      renderSeats(GL.globalSeats);
      if (GL.activeTab === "seat") renderSeatPanel();
    } catch (err) {
      console.error("panel dblclick clearSeat error:", err);
    }
  });

  GL.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      GL.activeTab = tab.dataset.tab === "seat" ? "seat" : "wait";
      if (GL.activeTab === "seat") {
        renderSeatPanel();
      } else {
        renderWaiting(getCurrentTournamentWaiting());
      }
    });
  });

  GL.menuBtn?.addEventListener("click", () => {
    GL.mobileSheet?.classList.remove("open");
    setPanelOpen(!GL.panelOpen);
  });

  GL.mobileAddSeatBtn?.addEventListener("click", () => {
    if (!GL.isAdminUser) return;
    if (layoutIsMobile()) {
      openGlobalMobileSeatAddFlow();
      return;
    }
    GL.activeTab = "seat";
    setPanelOpen(true);
    renderSeatPanel();
    requestAnimationFrame(() => document.getElementById("seatLabelInput")?.focus());
  });

  GL.mobileAddWaitingBtn?.addEventListener("click", () => {
    if (!GL.isAdminUser) return;
    if (layoutIsMobile()) {
      openGlobalMobileWaitingAddFlow();
      return;
    }
    GL.activeTab = "wait";
    setPanelOpen(true);
    renderWaiting(getCurrentTournamentWaiting());
    requestAnimationFrame(() => document.getElementById("manualWaitingNameInput")?.focus());
  });

  window.addEventListener("resize", () => {
    if (!layoutIsMobile()) {
      GL.mobileSheet?.classList.remove("open");
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!GL.panelOpen) return;
    const modal = document.getElementById("globalSeatEditModal");
    if (modal?.classList.contains("global-seat-edit-modal--open")) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    setPanelOpen(false);
  });

  GL.app?.addEventListener("pointerdown", (e) => {
    if (!GL.isAdminUser) return;
    const box = e.target.closest(".seat-box[data-seat-id]");
    if (!box) return;
    const seatId = String(box.getAttribute("data-seat-id") || "").trim();
    if (!seatId) return;
    const canvas = GL.app.querySelector(".pc-canvas");
    if (!canvas) return;

    const inner = canvas.querySelector(".canvas-inner") || canvas;
    const groupIds =
      GL.selectedSeatIds.has(seatId) && GL.selectedSeatIds.size > 1
        ? [...GL.selectedSeatIds]
        : [seatId];

    const boxesById = new Map();
    const startPositions = new Map();
    for (const sid of groupIds) {
      const b = sid === seatId ? box : findSeatBoxEl(inner, sid);
      if (!b) continue;
      boxesById.set(sid, b);
      startPositions.set(sid, {
        left: Number.parseFloat(b.style.left || "0") || 0,
        top: Number.parseFloat(b.style.top || "0") || 0
      });
    }
    if (!boxesById.size) return;

    GL.dragState = {
      captureBox: box,
      seatIds: [...boxesById.keys()],
      boxesById,
      canvas,
      startX: e.clientX,
      startY: e.clientY,
      startPositions,
      moved: false
    };
    box.setPointerCapture?.(e.pointerId);
  });

  GL.app?.addEventListener("pointermove", (e) => {
    if (!GL.dragState) return;
    const st = GL.dragState;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      st.moved = true;
    }
    const z = Math.max(0.15, GL.canvasZoom || 1);
    const inv = 1 / z;
    for (const sid of st.seatIds) {
      const b = st.boxesById.get(sid);
      const p = st.startPositions.get(sid);
      if (!b || !p) continue;
      const nextLeft = Math.max(0, p.left + dx * inv);
      const nextTop = Math.max(0, p.top + dy * inv);
      b.style.left = `${Math.round(nextLeft)}px`;
      b.style.top = `${Math.round(nextTop)}px`;
    }
  });

  GL.app?.addEventListener("pointerup", async (e) => {
    if (!GL.dragState) return;
    const current = GL.dragState;
    current.captureBox?.releasePointerCapture?.(e.pointerId);
    GL.dragState = null;
    if (!current.moved) return;
    GL.suppressSeatClickUntil = Date.now() + 220;
    try {
      await Promise.all(
        current.seatIds.map(async (sid) => {
          const b = current.boxesById.get(sid);
          if (!b) return;
          const left = Number.parseFloat(b.style.left || "0") || 0;
          const top = Number.parseFloat(b.style.top || "0") || 0;
          await saveSeatPosition(sid, left, top);
        })
      );
    } catch (err) {
      console.error("saveSeatPosition error:", err);
    }
  });

  GL.app?.addEventListener("pointercancel", (e) => {
    if (!GL.dragState) return;
    GL.dragState.captureBox?.releasePointerCapture?.(e.pointerId);
    GL.dragState = null;
  });

  GL.app?.addEventListener("click", async (e) => {
    if (!GL.isAdminUser) return;
    const box = e.target.closest(".seat-box[data-seat-id]");
    if (!box) return;
    if (Date.now() < GL.suppressSeatClickUntil) return;

    const seatId = String(box.getAttribute("data-seat-id") || "").trim();
    if (!seatId) return;
    const seat = getSeatById(seatId);
    if (!seat) return;

    if (e.detail >= 2 && !GL.selectedWaitingId) {
      if (!isEmptyPerson(String(seat.person || "").trim())) {
        try {
          await clearSeat(seatId);
          renderSeats(GL.globalSeats);
          if (GL.activeTab === "seat") renderSeatPanel();
        } catch (err) {
          console.error("click detail clearSeat error:", err);
        }
      }
      return;
    }

    if (String(GL.selectedWaitingId || "").trim() && !isMultiSelectPointer(e)) {
      try {
        await assignSelectedWaitingToSeat(seatId);
        renderWaiting(getCurrentTournamentWaiting());
        if (GL.activeTab === "seat") renderSeatPanel();
        renderSeats(GL.globalSeats);
      } catch (err) {
        if (String(err?.message || "").includes("same_person_noop")) {
          alert("이미 그 Seat에 있는 사람입니다.");
        } else if (String(err?.message || "").includes("waiting_not_found")) {
          alert("해당 대기자가 이미 처리되었습니다.");
        } else {
          console.error("canvas assignSelectedWaitingToSeat error:", err);
          alert("대기 배치에 실패했습니다.");
        }
      }
      return;
    }

    applyCanvasSeatSelectionClick(seatId, isMultiSelectPointer(e));
    renderSeats(GL.globalSeats);
    if (GL.activeTab === "seat") renderSeatPanel();
  });

  window.addEventListener("keydown", async (e) => {
    if (!GL.isAdminUser) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (GL.activeTab === "wait" && GL.selectedWaitingId) {
      try {
        await removeManualWaiting(GL.selectedWaitingId);
        renderWaiting(getCurrentTournamentWaiting());
      } catch (err) {
        console.error("keyboard removeManualWaiting error:", err);
      }
      return;
    }
    const toDelete = [...GL.selectedSeatIds];
    if (!toDelete.length) return;
    if (toDelete.length > 1 && !confirm(`선택한 ${toDelete.length}개의 좌석을 삭제하시겠습니까?`)) {
      return;
    }
    try {
      for (const sid of toDelete) {
        await deleteGlobalSeat(sid);
      }
      renderSeats(GL.globalSeats);
      if (GL.activeTab === "seat") renderSeatPanel();
    } catch (err) {
      console.error("keyboard deleteGlobalSeat error:", err);
    }
  });

  syncGlobalLayoutMobileChrome();
}
