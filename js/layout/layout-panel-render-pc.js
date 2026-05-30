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
    assignWaitingToSeat,
    setWaitingBlockChecked,
    undoLastAction,
    onFullRender,
    onPanelRefresh,
    onTimersUpdate,
    isSeatMine
  } = deps;

  if (!panelContent.dataset.layoutSeatDelegated) {
    panelContent.dataset.layoutSeatDelegated = "1";
    panelContent.addEventListener("click", async (e) => {
      const assignBtn = e.target.closest("[data-assign-seat]");
      if (assignBtn) {
        e.stopPropagation();
        if (!ui.selectedWaitingId) return;
        const sid = assignBtn.getAttribute("data-assign-seat");
        if (!sid) return;
        await assignWaitingToSeat(ui.selectedWaitingId, sid);
        ui.selectedSeatId = null;
        onFullRender();
        return;
      }
      const delBtn = e.target.closest("[data-del]");
      if (delBtn) {
        e.stopPropagation();
        deleteSeat(delBtn.getAttribute("data-del"));
        return;
      }
      const clearBtn = e.target.closest("[data-clear-seat]");
      if (clearBtn) {
        e.stopPropagation();
        await clearSeat(clearBtn.getAttribute("data-clear-seat"));
        return;
      }
      const row = e.target.closest("[data-sid]");
      if (!row) return;
      if (
        e.target.closest("[data-del]") ||
        e.target.closest("[data-clear-seat]") ||
        e.target.closest("[data-assign-seat]") ||
        e.target.closest(".time-chip") ||
        e.target.closest(".pill-inline")
      ) {
        return;
      }
      const sid = row.getAttribute("data-sid");
      if (ui.selectedWaitingId && canManageLayout()) {
        await assignWaitingToSeat(ui.selectedWaitingId, sid);
        ui.selectedSeatId = null;
        onFullRender();
        return;
      }
      ui.selectedSeatId = ui.selectedSeatId === sid ? null : sid;
      if (onPanelRefresh) onPanelRefresh();
      else onFullRender();
    });
  }

  if (!panelContent.dataset.layoutWaitDelegated) {
    panelContent.dataset.layoutWaitDelegated = "1";
    panelContent.addEventListener("click", (e) => {
      const addBtn = e.target.closest("#addWaitBtn");
      if (addBtn) {
        const input = document.getElementById("waitNameInput");
        const name = String(input?.value || "").trim();
        if (!name) return;
        addWaiting(name);
        return;
      }
      const delBtn = e.target.closest("[data-del-w]");
      if (delBtn) {
        e.stopPropagation();
        deleteWaiting(delBtn.getAttribute("data-del-w"));
        return;
      }
      const row = e.target.closest("[data-wid]");
      if (!row) return;
      if (e.target.closest("[data-del-w]") || e.target.closest("[data-block-w]")) return;
      const wid = row.getAttribute("data-wid");
      ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
      ui.selectedSeatId = null;
      onPanelRefresh();
      onTimersUpdate();
    });
    panelContent.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target?.id !== "waitNameInput") return;
      document.getElementById("addWaitBtn")?.click();
    });
    panelContent.addEventListener("change", async (e) => {
      const cb = e.target.closest("[data-block-w]");
      if (!cb) return;
      e.stopPropagation();
      await setWaitingBlockChecked(cb.getAttribute("data-block-w"), cb.checked);
    });
  }

  function renderWaitPanel() {
    const selected = ui.selectedWaitingId;
    const html = [];
    const displayWaiting = getWaitingListForDisplay();

    if (canManageLayout()) {
      html.push(`<input id="waitNameInput" placeholder="-" />`);
      html.push(`<button id="addWaitBtn" class="btn primary" style="width:100%; margin-bottom:12px;">+ 대기 추가</button>`);
    } else {
      html.push(`<div class="badge" style="margin-bottom:12px;">대기 관리는 운영 권한이 필요합니다</div>`);
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

    const listHtml = html.slice(2).join("");
    const existingWaitList = panelContent.querySelector(".layout-wait-list");
    const existingAddBtn = document.getElementById("addWaitBtn");
    if (existingWaitList && existingAddBtn) {
      existingWaitList.innerHTML = listHtml;
      onTimersUpdate();
      return;
    }

    const waitShellStart = html.slice(0, 2).join("");
    panelContent.innerHTML =
      waitShellStart +
      `<div class="layout-wait-list">${listHtml}</div>`;
  }

  function renderSeatPanel() {
    const waitingAll = getWaitingListForDisplay();
    const selectedWaiting = ui.selectedWaitingId
      ? waitingAll.find((w) => w.id === ui.selectedWaitingId) || null
      : null;

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

    if (canManageLayout() && selectedWaiting) {
      left.push(`
        <div class="mobile-selection-banner layout-seat-assign-banner">
          <span class="badge sel">배치할 대기</span>
          <strong>${escapeHtml(selectedWaiting.name)}</strong>
        </div>
      `);
    }

    const listRows = [];
    if (eventState.seats.length === 0) {
      listRows.push(`
        <div class="empty-panel">현재 이벤트(${escapeHtml(EVENT_ID)})에 Seat이 없습니다.</div>
      `);
    } else {
      getSortedSeats(eventState.seats).forEach((s) => {
        const isSel = ui.selectedSeatId === s.id;
        const hasPerson = !isEmptyPerson(s.person);
        const start = hasPerson ? (s.seatedAt || Date.now()) : null;
        const isSelf = hasPerson && !!isSeatMine?.(s);

        listRows.push(`
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
                      ${
                        selectedWaiting
                          ? `<button class="pill-inline primary" type="button" data-assign-seat="${s.id}">배치</button>`
                          : ``
                      }
                      `
                      : ``
                  }
                </div>
              </div>
            </div>
          `);
      });
    }

    const listHtml = listRows.join("");
    const shellHtml = left.join("");
    const existingSeatList = panelContent.querySelector(".layout-seat-tab-list");
    const existingMeta = panelContent.querySelector(".global-meta");
    if (existingSeatList && existingMeta) {
      const metaLeft = existingMeta.querySelector(".global-meta-left");
      if (metaLeft) {
        metaLeft.innerHTML = `
          <span class="hint-pill">SEAT: ${seatCount}</span>
          <span class="hint-pill">WAIT: ${waitCount}</span>
        `;
      }
      const undoBtn = existingMeta.querySelector("#globalUndoToolbarBtn");
      if (undoBtn) undoBtn.disabled = !ui.lastUndoAction;
      existingSeatList.innerHTML = listHtml;
      const banner = panelContent.querySelector(".layout-seat-assign-banner");
      if (canManageLayout() && selectedWaiting) {
        const bannerHtml = `
        <div class="mobile-selection-banner layout-seat-assign-banner">
          <span class="badge sel">배치할 대기</span>
          <strong>${escapeHtml(selectedWaiting.name)}</strong>
        </div>`;
        if (banner) banner.outerHTML = bannerHtml;
        else existingSeatList.insertAdjacentHTML("beforebegin", bannerHtml);
      } else if (banner) {
        banner.remove();
      }
      const orderBtn = document.getElementById("sortSeatOrderBtn");
      const timeBtn = document.getElementById("sortSeatTimeBtn");
      orderBtn?.classList.toggle("active", ui.seatSortMode === "seat");
      timeBtn?.classList.toggle("active", ui.seatSortMode === "time");
      onTimersUpdate();
      return;
    }

    panelContent.innerHTML = `${shellHtml}<div class="global-list layout-seat-tab-list">${listHtml}</div>`;

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

  }

  return { renderWaitPanel, renderSeatPanel };
}
