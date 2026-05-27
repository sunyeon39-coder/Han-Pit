/**
 * layout.html: PC 우측 패널 — 대기 목록 + Seat 탭
 */
export function createLayoutPcPanelRender(deps) {
  const {
    panelContent,
    ui,
    eventState,
    EVENT_ID,
    escapeHtml,
    isEmptyPerson,
    canManageLayout,
    getWaitingListForDisplay,
    getSortedSeats,
    getWaitingDisplayStartMs,
    sortWaitingAscending,
    seatCanvasDigitsOnly,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    setWaitingBlockChecked,
    undoLastAction,
    onFullRender,
    onPanelRefresh,
    onTimersUpdate,
    isSeatMine
  } = deps;

  function renderWaitPanel() {
    const selected = ui.selectedWaitingId;
    const html = [];
    const displayWaiting = getWaitingListForDisplay();

    if (canManageLayout()) {
      html.push(`<input id="waitNameInput" placeholder="-" />`);
      html.push(`<button id="addWaitBtn" class="btn primary" style="width:100%; margin-bottom:12px;">+ 대기 추가</button>`);
    } else {
      html.push(`<div class="badge" style="margin-bottom:12px;">대기 관리는 admin만 가능합니다</div>`);
    }

    if (displayWaiting.length === 0) {
      html.push(`
        <div class="row">
          <div class="left">
            <div>대기자 없음</div>
          </div>
        </div>
      `);
    } else {
      sortWaitingAscending(displayWaiting).forEach((w) => {
        const isSel = selected === w.id;
        const start = getWaitingDisplayStartMs(w);
        const blocked = w.blockChecked === true;
        html.push(`
          <div class="row ${isSel ? "selected" : ""} ${blocked ? "is-blocked" : ""}" data-wid="${w.id}" style="cursor:pointer;">
            <div class="left layout-wait-row-left">
              ${
                canManageLayout()
                  ? `<label class="wait-block-check-wrap" title="체크 시 배치 블락 + 체크 시각 기준 타이머">
                      <input type="checkbox" class="wait-block-check" data-block-w="${w.id}" ${blocked ? "checked" : ""} />
                    </label>`
                  : ``
              }
              <div class="layout-wait-name" style="font-weight:900;">${escapeHtml(w.name)}</div>
              ${blocked ? `<span class="wait-block-badge">BLOCK</span>` : ``}
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="time-chip" data-timer="wait" data-start="${start}" data-target="wait:${w.id}">00:00:00</span>
              ${
                canManageLayout()
                  ? `<button class="btn small danger" data-del-w="${w.id}">삭제</button>`
                  : ``
              }
            </div>
          </div>
        `);
      });
    }

    panelContent.innerHTML = html.join("");

    if (canManageLayout()) {
      const addBtn = document.getElementById("addWaitBtn");
      const input = document.getElementById("waitNameInput");

      addBtn?.addEventListener("click", () => {
        const name = String(input?.value || "").trim();
        if (!name) return;
        addWaiting(name);
      });

      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn?.click();
      });
    }

    panelContent.querySelectorAll("[data-wid]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-del-w]") || e.target.closest("[data-block-w]")) return;
        const wid = row.getAttribute("data-wid");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        ui.selectedSeatId = null;
        onPanelRefresh();
        onTimersUpdate();
      });
    });

    panelContent.querySelectorAll("[data-del-w]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWaiting(btn.getAttribute("data-del-w"));
      });
    });

    panelContent.querySelectorAll("[data-block-w]").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        e.stopPropagation();
        const wid = cb.getAttribute("data-block-w");
        await setWaitingBlockChecked(wid, cb.checked);
      });
    });
  }

  function renderSeatPanel() {
    const waitingAll = getWaitingListForDisplay();

    const left = [];
    const seatCount = eventState.seats.length;
    const waitCount = waitingAll.filter((w) => w.blockChecked !== true).length;
    const metaActionsHidden = !canManageLayout();

    left.push(`
      <div class="global-meta">
        <div class="global-meta-left">
          <span class="hint-pill">SEAT: ${seatCount}</span>
          <span class="hint-pill">WAIT: ${waitCount}</span>
        </div>
        <div class="global-meta-actions ${metaActionsHidden ? "hidden" : ""}" aria-hidden="${metaActionsHidden ? "true" : "false"}">
          <button type="button" id="globalUndoToolbarBtn" class="pill-inline seat-meta-btn seat-meta-btn--undo" ${ui.lastUndoAction ? "" : "disabled"}>되돌리기</button>
        </div>
      </div>
    `);

    left.push(`
      <div class="global-form-seat-add ${metaActionsHidden ? "hidden" : ""}" aria-hidden="${metaActionsHidden ? "true" : "false"}">
        <div class="seat-add-one-row">
          <div class="seat-add-leading" aria-hidden="true"></div>
          <button type="button" id="addSeatToolbarBtn" class="pill-inline primary seat-meta-btn seat-add-action-btn" title="+ Seat 추가">추가</button>
        </div>
      </div>
    `);

    left.push(`
      <div class="seat-sort-row">
        <button id="sortSeatOrderBtn" class="pill-inline ${ui.seatSortMode === "seat" ? "active" : ""}" type="button">Seat순</button>
        <button id="sortSeatTimeBtn" class="pill-inline ${ui.seatSortMode === "time" ? "active" : ""}" type="button">시간순</button>
      </div>
    `);

    left.push(`<div class="global-list layout-seat-tab-list">`);

    if (eventState.seats.length === 0) {
      left.push(`
        <div class="empty-panel">현재 이벤트(${escapeHtml(EVENT_ID)})에 Seat이 없습니다.</div>
      `);
    } else {
      getSortedSeats(eventState.seats).forEach((s) => {
        const isSel = ui.selectedSeatId === s.id;
        const hasPerson = !isEmptyPerson(s.person);
        const start = hasPerson ? (s.seatedAt || Date.now()) : null;
        const isSelf = hasPerson && !!isSeatMine?.(s);

        left.push(`
            <div class="seat-manage-row ${isSel ? "selected" : ""}" data-sid="${s.id}" style="cursor:pointer;">
              <div class="seat-manage-main seat-manage-main--oneline">
                <div class="seat-manage-namewrap seat-manage-namewrap--with-num">
                  <span class="seat-manage-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
                  <span class="seat-manage-name ${isEmptyPerson(s.person) ? "is-empty" : ""} ${isSelf ? "is-self" : ""}">
                    ${escapeHtml(s.person)}
                  </span>
                </div>
                <div class="seat-inline-actions">
                  ${
                    hasPerson
                      ? `<span class="time-chip"
                          data-timer="seat"
                          data-start="${start}"
                          data-target="seat:${s.id}">
                          00:00:00
                        </span>`
                      : `<span class="seat-manage-empty-dash">-</span>`
                  }
                  ${
                    canManageLayout()
                      ? `
                      ${
                        hasPerson
                          ? `<button class="pill-inline warn" type="button" data-clear-seat="${s.id}">비우기</button>`
                          : ``
                      }
                      <button class="pill-inline danger" type="button" data-del="${s.id}">삭제</button>
                      `
                      : ``
                  }
                </div>
              </div>
            </div>
          `);
      });
    }

    left.push(`</div>`);

    panelContent.innerHTML = left.join("");

    const globalUndoToolbarBtn = document.getElementById("globalUndoToolbarBtn");
    if (globalUndoToolbarBtn) {
      globalUndoToolbarBtn.onclick = () => {
        void undoLastAction();
      };
    }

    const addSeatToolbarBtn = document.getElementById("addSeatToolbarBtn");
    if (addSeatToolbarBtn) {
      addSeatToolbarBtn.onclick = () => {
        addSeat();
      };
    }

    const sortSeatOrderBtn = document.getElementById("sortSeatOrderBtn");
    if (sortSeatOrderBtn) {
      sortSeatOrderBtn.onclick = () => {
        ui.seatSortMode = "seat";
        onPanelRefresh();
        onTimersUpdate();
      };
    }

    const sortSeatTimeBtn = document.getElementById("sortSeatTimeBtn");
    if (sortSeatTimeBtn) {
      sortSeatTimeBtn.onclick = () => {
        ui.seatSortMode = "time";
        onPanelRefresh();
        onTimersUpdate();
      };
    }

    panelContent.querySelectorAll("[data-sid]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (
          e.target &&
          (e.target.closest("[data-del]") ||
            e.target.closest("[data-clear-seat]") ||
            e.target.closest(".time-chip") ||
            e.target.closest(".pill-inline"))
        ) {
          return;
        }

        const sid = el.getAttribute("data-sid");
        ui.selectedSeatId = ui.selectedSeatId === sid ? null : sid;
        ui.selectedWaitingId = null;
        onFullRender();
      });
    });

    panelContent.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSeat(btn.getAttribute("data-del"));
      });
    });

    panelContent.querySelectorAll("[data-clear-seat]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await clearSeat(btn.getAttribute("data-clear-seat"));
      });
    });
  }

  return { renderWaitPanel, renderSeatPanel };
}
