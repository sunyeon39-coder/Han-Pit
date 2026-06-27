import { GL } from "./state.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import {
  getSeatById,
  renderSeats,
  renderSeatPanel,
  renderWaiting,
  refreshGlobalLayoutPcOpsPanel,
  setPanelOpen,
  invalidateWaitingPanelFingerprint
} from "./panel-ui.js";
import { canManageGlobalLayoutOps, canViewGlobalLayoutSeatHistory } from "./ops-access.js";
import {
  applyOptimisticWaitingBlockRow,
  applyWaitingBlockLocal,
  getCurrentTournamentWaiting
} from "./waiting.js";
import { updateGlobalLayoutWaitingMeta } from "./meta-ui.js";
import { flushOptimisticGlobalLayoutUi } from "./optimistic-seat-mutation.js";
import {
  saveSeatPosition,
  assignSelectedWaitingToSeat,
  clearSeat,
  deleteGlobalSeat,
  addGlobalSeat,
  addManualWaiting,
  addManualWaitingByName,
  removeManualWaiting,
  setWaitingBlocked,
  undoLastGlobalAction,
  redoLastGlobalAction
} from "./firestore-ops.js";
import { initGlobalSeatEditModal, openSeatEditModal } from "./seat-edit-modal.js";
import {
  initGlobalSeatHistoryModal,
  openSeatHistoryModal,
  tryOpenSeatHistoryFromPersonClick,
  wireSeatHistoryLongPress
} from "./seat-history-modal.js";
import {
  initGlobalMobileSeatAddModal,
  openGlobalMobileSeatAddModal
} from "./mobile-seat-add-modal.js";
import { setWaitingRowSelection, syncSelectedWaitingFromMyOperatorPick } from "./waiting-picks.js";
import { refreshGlobalLayoutAlignButtonState } from "./canvas-viewport.js";
import { fmtElapsed, isEmptyPerson, timerClass } from "./utils.js";
import { getGlobalRedoCount, getGlobalUndoCount } from "./undo-stack.js";

const GLOBAL_SEAT_DOUBLE_ACTIVATE_MS = 350;

function assignSeatFailureHint(err) {
  const code = String(err?.code || "").trim();
  if (code === "resource-exhausted") {
    return "\n\nFirestore 요청 한도를 초과했습니다. 10~30초 후 다시 시도해 주세요.";
  }
  if (code === "failed-precondition" || code === "unavailable") {
    return "\n\n네트워크·Safari 연결 문제이거나 저장 순서 오류일 수 있습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "";
}

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

function runGlobalMobileAddSeat() {
  void openGlobalMobileSeatAddModal();
}

async function runGlobalMobileAddWaiting() {
  GL.mobileSheet?.classList.remove("open");
  const name = prompt("대기자 이름", "");
  if (name === null) return;
  try {
    await addManualWaitingByName(name);
  } catch (err) {
    console.error("addManualWaitingByName error:", err);
    alert("대기 추가에 실패했습니다.");
  }
}

/** 관리자 로그인 후 하단 시트 버튼 표시 */
export function syncGlobalLayoutMobileChrome() {
  const show = canManageGlobalLayoutOps();
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
  initGlobalSeatHistoryModal();
  initGlobalMobileSeatAddModal();

  // 캔버스 좌석은 길게 누르기 대신 우측 상단 버튼으로 이력을 연다(드래그 이동과 충돌 방지).
  if (GL.panelContent) {
    wireSeatHistoryLongPress(GL.panelContent, {
      canOpen: () => canViewGlobalLayoutSeatHistory()
    });
  }

  GL.backBtn?.addEventListener("click", () => {
    location.href = `./index.html?tournamentId=${encodeURIComponent(GL.tournamentId)}`;
  });

  document.getElementById("metaStats")?.addEventListener("click", async (e) => {
    if (!canManageGlobalLayoutOps()) return;
    if (layoutIsMobile() && GL.activeTab !== "seat") return;
    if (e.target.closest("#globalUndoToolbarBtn")) {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.target.closest("#globalUndoToolbarBtn");
      if (getGlobalUndoCount() <= 0 || btn?.disabled) return;
      await undoLastGlobalAction();
      return;
    }
    if (e.target.closest("#globalRedoToolbarBtn")) {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.target.closest("#globalRedoToolbarBtn");
      if (getGlobalRedoCount() <= 0 || btn?.disabled) return;
      await redoLastGlobalAction();
    }
  });

  GL.panelContent?.addEventListener("click", async (e) => {
    const selectSeatRowEarly = e.target.closest("[data-select-seat]");
    if (
      selectSeatRowEarly &&
      !e.target.closest("[data-assign-seat],[data-clear-seat],[data-delete-seat],[data-rename-seat]")
    ) {
      const sid = String(selectSeatRowEarly.getAttribute("data-select-seat") || "").trim();
      if (sid && tryOpenSeatHistoryFromPersonClick(e, sid)) return;
    }

    if (!canManageGlobalLayoutOps() && !GL.opsServerVerified) return;

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
        flushOptimisticGlobalLayoutUi();
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
      } catch (err) {
        console.error("clearSeat error:", err);
        alert("Seat 비우기에 실패했습니다.");
      }
      return;
    }

    const assignBtn = e.target.closest("[data-assign-seat]");
    if (assignBtn) {
      syncSelectedWaitingFromMyOperatorPick();
      if (!String(GL.selectedWaitingId || "").trim()) return;
      const sid = String(assignBtn.getAttribute("data-assign-seat") || "");
      try {
        await assignSelectedWaitingToSeat(sid);
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
          console.error("assignSelectedWaitingToSeat error:", err);
          alert(`대기 배치에 실패했습니다.${assignSeatFailureHint(err)}`);
        }
      }
      return;
    }

    const deleteSeatBtn = e.target.closest("[data-delete-seat]");
    if (deleteSeatBtn) {
      const sid = String(deleteSeatBtn.getAttribute("data-delete-seat") || "").trim();
      const docId = String(deleteSeatBtn.getAttribute("data-delete-doc") || "").trim();
      if (!sid && !docId) return;
      if (!confirm("이 좌석을 삭제하시겠습니까?")) return;
      try {
        await deleteGlobalSeat(sid, { firestoreDocId: docId });
        flushOptimisticGlobalLayoutUi();
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
        refreshGlobalLayoutAlignButtonState();
      }
      return;
    }

    const deleteWaitBtn = e.target.closest("[data-delete-wid]");
    if (deleteWaitBtn) {
      const widToDelete = String(deleteWaitBtn.getAttribute("data-delete-wid") || "");
      if (!widToDelete) return;
      if (!confirm("대기자를 삭제하시겠습니까?")) return;
      await removeManualWaiting(widToDelete);
      return;
    }

    if (e.target.closest(".wait-check-slot, input[data-block-wid]")) return;

    const row = e.target.closest("[data-wid]");
    if (!row) return;
    const wid = String(row.getAttribute("data-wid") || "");
    if (!wid) return;
    setWaitingRowSelection(wid);
  });

  GL.panelContent?.addEventListener("change", async (e) => {
    const blockCb = e.target.closest("[data-block-wid]");
    if (!blockCb) return;
    e.stopPropagation();
    if (!canManageGlobalLayoutOps()) {
      blockCb.checked = !blockCb.checked;
      alert("운영 권한이 필요합니다.");
      return;
    }
    const wid = String(blockCb.getAttribute("data-block-wid") || "").trim();
    if (!wid) return;
    const nextChecked = !!blockCb.checked;
    applyWaitingBlockLocal(wid, nextChecked);
    invalidateWaitingPanelFingerprint();
    renderWaiting(getCurrentTournamentWaiting());
    updateGlobalLayoutWaitingMeta();
    blockCb.disabled = true;
    try {
      await setWaitingBlocked(wid, nextChecked);
    } catch (err) {
      console.error("setWaitingBlocked error:", err);
      alert("BLOCK 체크 변경에 실패했습니다.");
      flushOptimisticGlobalLayoutUi();
    } finally {
      blockCb.disabled = false;
    }
  });

  GL.panelContent?.addEventListener("dblclick", async (e) => {
    if (!canManageGlobalLayoutOps()) return;
    const row = e.target.closest("[data-select-seat]");
    if (!row) return;
    const seatId = String(row.getAttribute("data-select-seat") || "").trim();
    if (!seatId) return;
    const seat = getSeatById(seatId);
    if (!seat) return;
    if (isEmptyPerson(String(seat.person || "").trim())) return;
    try {
      await clearSeat(seatId);
    } catch (err) {
      console.error("panel dblclick clearSeat error:", err);
    }
  });

  GL.menuBtn?.addEventListener("click", () => {
    if (layoutIsMobile()) {
      setPanelOpen(false);
      GL.mobileSheet?.classList.toggle("open");
      return;
    }
    GL.mobileSheet?.classList.remove("open");
    setPanelOpen(!GL.panelOpen);
  });

  GL.mobileAddSeatBtn?.addEventListener("click", () => {
    if (!canManageGlobalLayoutOps()) return;
    if (layoutIsMobile()) {
      void runGlobalMobileAddSeat();
      return;
    }
    GL.activeTab = "seat";
    setPanelOpen(true);
    renderSeatPanel();
    requestAnimationFrame(() => document.getElementById("seatLabelInput")?.focus());
  });

  GL.mobileAddWaitingBtn?.addEventListener("click", () => {
    if (!canManageGlobalLayoutOps()) return;
    if (layoutIsMobile()) {
      void runGlobalMobileAddWaiting();
      return;
    }
    GL.activeTab = "wait";
    setPanelOpen(true);
    renderWaiting(getCurrentTournamentWaiting());
    requestAnimationFrame(() => document.getElementById("manualWaitingNameInput")?.focus());
  });

  window.addEventListener("resize", () => {
    if (layoutIsMobile()) {
      setPanelOpen(false);
      GL.mobileSheet?.classList.remove("open");
    } else {
      GL.mobileSheet?.classList.remove("open");
    }
    renderSeats(GL.globalSeats);
    if (!layoutIsMobile()) refreshGlobalLayoutPcOpsPanel();
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
    if (!canManageGlobalLayoutOps()) return;
    if (e.target.closest(".seat-history-btn")) return;
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

  async function handleCanvasSeatActivate(seatId, e = null) {
    const sid = String(seatId || "").trim();
    if (!sid) return;
    const seat = getSeatById(sid);
    if (!seat) return;
    const now = Date.now();
    const isSameSeatQuickTap =
      GL.lastSeatTapId === sid && now - Number(GL.lastSeatTapAt || 0) < GLOBAL_SEAT_DOUBLE_ACTIVATE_MS;
    const isDoubleActivate = Number(e?.detail || 0) >= 2 || isSameSeatQuickTap;

    if (isDoubleActivate && !GL.selectedWaitingId) {
      if (!isEmptyPerson(String(seat.person || "").trim())) {
        try {
          await clearSeat(sid);
          GL.lastSeatTapAt = 0;
          GL.lastSeatTapId = "";
        } catch (err) {
          console.error("canvas seat clearSeat error:", err);
        }
      }
      return;
    }

    GL.lastSeatTapAt = now;
    GL.lastSeatTapId = sid;

    if (String(GL.selectedWaitingId || "").trim() && !isMultiSelectPointer(e)) {
      syncSelectedWaitingFromMyOperatorPick();
      if (!String(GL.selectedWaitingId || "").trim()) return;
      try {
        await assignSelectedWaitingToSeat(sid);
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
          console.error("canvas assignSelectedWaitingToSeat error:", err);
          alert(`대기 배치에 실패했습니다.${assignSeatFailureHint(err)}`);
        }
      }
      return;
    }

    applyCanvasSeatSelectionClick(sid, isMultiSelectPointer(e));
    renderSeats(GL.globalSeats);
    if (layoutIsMobile()) {
      if (GL.activeTab === "seat") renderSeatPanel();
    } else {
      refreshGlobalLayoutPcOpsPanel();
    }
    refreshGlobalLayoutAlignButtonState();
  }

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
    if (!current.moved) {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        const sid = String(current.captureBox?.getAttribute("data-seat-id") || "").trim();
        if (sid) {
          GL.suppressSeatClickUntil = Date.now() + 300;
          await handleCanvasSeatActivate(sid, e);
        }
      }
      return;
    }
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
    const historyBtn = e.target.closest(".seat-history-btn");
    if (historyBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (!canViewGlobalLayoutSeatHistory()) return;
      const sid = String(historyBtn.getAttribute("data-seat-history") || "").trim();
      if (sid) {
        GL.suppressSeatClickUntil = Date.now() + 300;
        openSeatHistoryModal(sid);
      }
      return;
    }

    // 캔버스 좌석 이력은 우측 상단 버튼으로만 연다(이름/박스 클릭으로는 열지 않음).
    const box = e.target.closest(".seat-box[data-seat-id]");

    if (!canManageGlobalLayoutOps()) return;

    if (box) {
      if (Date.now() < GL.suppressSeatClickUntil) return;

      const seatId = String(box.getAttribute("data-seat-id") || "").trim();
      if (!seatId) return;
      await handleCanvasSeatActivate(seatId, e);
      return;
    }

    if (!String(GL.selectedWaitingId || "").trim()) return;
    if (!e.target.closest(".layout-canvas-viewport")) return;

    GL.selectedWaitingId = "";
    void syncMyWaitingPick("");
    flushOptimisticGlobalLayoutUi();
  });

  window.addEventListener("keydown", async (e) => {
    if (!canManageGlobalLayoutOps()) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (GL.selectedWaitingId && (layoutIsMobile() ? GL.activeTab === "wait" : true)) {
      try {
        await removeManualWaiting(GL.selectedWaitingId);
        flushOptimisticGlobalLayoutUi();
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
      for (const key of toDelete) {
        const seat = GL.globalSeats.find(
          (s) =>
            String(s.seatId || "").trim() === key ||
            String(s.__firestoreDocId || "").trim() === key
        );
        await deleteGlobalSeat(String(seat?.seatId || key || "").trim(), {
          firestoreDocId: String(seat?.__firestoreDocId || key || "").trim()
        });
      }
      renderSeats(GL.globalSeats);
      if (layoutIsMobile()) {
        if (GL.activeTab === "seat") renderSeatPanel();
      } else {
        refreshGlobalLayoutPcOpsPanel();
      }
    } catch (err) {
      console.error("keyboard deleteGlobalSeat error:", err);
    }
  });

  syncGlobalLayoutMobileChrome();
}
