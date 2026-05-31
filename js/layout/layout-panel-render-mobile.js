/**
 * layout.html: 모바일 Seat/대기 카드 UI
 */
import { LAYOUT_SEAT_DOUBLE_ACTIVATE_MS } from "./layout-core-utils.js";

export function createLayoutMobilePanelRender(deps) {
  const {
    app,
    ui,
    eventState,
    escapeHtml,
    isEmptyPerson,
    canManageLayout,
    getWaitingListForDisplay,
    getSortedSeats,
    getWaitingDisplayStartMs,
    seatCanvasDigitsOnly,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    clearSeat,
    assignWaitingToSeat,
    setWaitingBlockChecked,
    onFullRender,
    isSeatMine
  } = deps;

  function renderMobile() {
    const wrap = document.createElement("div");
    wrap.className = "mobile";

    const displayWaitingMobile = getWaitingListForDisplay();
    const selectedWaiting =
      ui.selectedWaitingId
        ? displayWaitingMobile.find((w) => w.id === ui.selectedWaitingId) || null
        : null;

    const seatCard = document.createElement("div");
    seatCard.className = "card";
    seatCard.innerHTML = `
      <div class="mobile-section-head">
        <h3>Seat</h3>
        ${
          canManageLayout()
            ? `<button id="mobileAddSeatInline" class="btn primary">+ Seat 추가</button>`
            : ``
        }
      </div>
    `;

    if (canManageLayout() && selectedWaiting) {
      seatCard.innerHTML += `
        <div class="mobile-selection-banner">
          <span class="badge sel">배치할 대기</span>
          <strong>${escapeHtml(selectedWaiting.name)}</strong>
        </div>
      `;
    }

    if (eventState.seats.length === 0) {
      seatCard.innerHTML += `
        <div class="row">
          <div>Seat</div>
          <div class="muted">없음</div>
        </div>
      `;
    } else {
      getSortedSeats(eventState.seats).forEach((s) => {
        const hasPerson = !isEmptyPerson(s.person);
        const start = hasPerson ? (s.seatedAt || Date.now()) : null;
        const isSel = ui.selectedSeatId === s.id;
        const isSelf = hasPerson && !!isSeatMine?.(s);

        const manage = canManageLayout();
        const assignLabel = selectedWaiting
          ? escapeHtml(`${selectedWaiting.name} 이 Seat에 배치`)
          : "";
        seatCard.innerHTML += `
            <div class="mobile-seat-row compact ${isSel ? "selected" : ""}" data-mobile-seat="${s.id}">
              <div class="mobile-seat-mainline">
                <div class="mobile-seat-name-cluster">
                  <span class="mobile-seat-num">${escapeHtml(seatCanvasDigitsOnly(s.label, s.no))}</span>
                  <div class="mobile-seat-person ${isEmptyPerson(s.person) ? "is-empty" : ""} ${isSelf ? "is-self" : ""}">
                    ${isEmptyPerson(s.person) ? "비어있음" : escapeHtml(s.person)}
                  </div>
                </div>
                ${
                  manage
                    ? `
                <div class="mobile-seat-inline-actions">
                  ${
                    hasPerson
                      ? `<button type="button" class="mobile-pill-btn warn" data-clear-seat="${s.id}">비우기</button>`
                      : ""
                  }
                  <button type="button" class="mobile-pill-btn danger" data-del="${s.id}">삭제</button>
                  ${
                    selectedWaiting
                      ? `<button type="button" class="mobile-pill-btn primary mobile-pill-btn--assign-seat" data-mobile-assign="${s.id}" aria-label="${assignLabel}">배치</button>`
                      : ""
                  }
                </div>
                `
                    : ""
                }
                <div class="mobile-seat-right">
                  ${
                    hasPerson
                      ? `<span class="time-chip" data-timer="seat" data-start="${start}" data-target="seat:${s.id}">00:00:00</span>`
                      : `<span class="mobile-empty-dash">—</span>`
                  }
                </div>
              </div>
            </div>
          `;
      });
    }

    const waitCard = document.createElement("div");
    waitCard.className = "card";
    waitCard.innerHTML = `
      <div class="mobile-section-head">
        <h3>대기</h3>
        ${
          canManageLayout()
            ? `<button id="mobileAddWaitingInline" class="btn primary">+ 대기 추가</button>`
            : ``
        }
      </div>
    `;

    const sortedWaiting = [...displayWaitingMobile].sort(
      (a, b) => getWaitingDisplayStartMs(a) - getWaitingDisplayStartMs(b)
    );

    if (sortedWaiting.length === 0) {
      waitCard.innerHTML += `
        <div class="row">
          <div>대기</div>
          <div class="muted">없음</div>
        </div>
      `;
    } else {
      sortedWaiting.forEach((w) => {
        const start = getWaitingDisplayStartMs(w);
        const isSel = ui.selectedWaitingId === w.id;
        const blocked = w.blockChecked === true;

        waitCard.innerHTML += `
          <div class="mobile-wait-row compact ${isSel ? "selected" : ""} ${blocked ? "is-blocked" : ""}" data-mobile-wait="${w.id}">
            <div class="mobile-wait-mainline">
              <div class="mobile-wait-inline">
                ${
                  canManageLayout()
                    ? `<label class="wait-block-check-wrap" title="체크 시 배치 블락 + 체크 시각 기준 타이머">
                        <input type="checkbox" class="wait-block-check" data-mobile-block-w="${w.id}" ${blocked ? "checked" : ""} />
                      </label>`
                    : ``
                }
                <div class="mobile-wait-name">
                  ${escapeHtml(w.name)}
                </div>
                ${blocked ? `<span class="wait-block-badge">BLOCK</span>` : ``}

                ${
                  canManageLayout()
                    ? `
                    <div class="mobile-wait-inline-actions">
                     

                      <button class="mobile-pill-btn danger" data-del-w="${w.id}">
                        삭제
                      </button>
                    </div>
                    `
                    : ``
                }
              </div>

              <div class="mobile-wait-right">
                <span class="time-chip" data-timer="wait" data-start="${start}" data-target="wait:${w.id}">
                  00:00:00
                </span>
              </div>
            </div>
          </div>
        `;
      });
    }

    wrap.append(seatCard, waitCard);
    app.appendChild(wrap);

    if (!canManageLayout()) return;

    const addSeatBtn = document.getElementById("mobileAddSeatInline");
    if (addSeatBtn) {
      addSeatBtn.onclick = () => addSeat();
    }

    const addWaitBtn = document.getElementById("mobileAddWaitingInline");
    if (addWaitBtn) {
      addWaitBtn.onclick = () => {
        const name = prompt("대기자 이름");
        if (name) addWaiting(name);
      };
    }

    wrap.querySelectorAll("[data-mobile-seat]").forEach((row) => {
      row.addEventListener("click", async (e) => {
        if (
          e.target.closest("[data-mobile-seat-select]") ||
          e.target.closest("[data-del]") ||
          e.target.closest("[data-mobile-assign]") ||
          e.target.closest("[data-clear-seat]")
        ) {
          return;
        }

        const sid = row.getAttribute("data-mobile-seat");
        if (!sid) return;

        const seatObj = eventState.seats.find((x) => x.id === sid);
        const occupied = seatObj && !isEmptyPerson(seatObj.person);
        const now = Date.now();

        if (ui.selectedWaitingId) {
          const wid = ui.selectedWaitingId;
          ui.selectedSeatId = sid;
          void assignWaitingToSeat(wid, sid);
          ui.selectedSeatId = null;
          ui.lastMobileTapAt = 0;
          ui.lastMobileSeatId = "";
          onFullRender();
          return;
        }

        if (occupied && canManageLayout()) {
          if (ui.lastMobileSeatId === sid && now - ui.lastMobileTapAt < LAYOUT_SEAT_DOUBLE_ACTIVATE_MS) {
            ui.lastMobileTapAt = 0;
            ui.lastMobileSeatId = "";
            await clearSeat(sid);
            ui.selectedSeatId = null;
            onFullRender();
            return;
          }

          ui.lastMobileTapAt = now;
          ui.lastMobileSeatId = sid;
          ui.selectedSeatId = sid;
          onFullRender();
          return;
        }

        ui.lastMobileTapAt = now;
        ui.lastMobileSeatId = sid;
        ui.selectedSeatId = sid;
        onFullRender();
      });
    });

    wrap.querySelectorAll("[data-mobile-wait]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-mobile-wait-select]") || e.target.closest("[data-del-w]")) {
          return;
        }
        if (e.target.closest("input.wait-block-check")) return;

        const wid = row.getAttribute("data-mobile-wait");
        if (!wid) return;

        ui.selectedWaitingId = wid;
        ui.selectedSeatId = null;
        onFullRender();
      });
    });

    wrap.querySelectorAll("[data-mobile-wait-select]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wid = btn.getAttribute("data-mobile-wait-select");
        ui.selectedWaitingId = ui.selectedWaitingId === wid ? null : wid;
        onFullRender();
      });
    });

    wrap.querySelectorAll("[data-mobile-assign]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute("data-mobile-assign");

        if (!ui.selectedWaitingId) return;

        const wid = ui.selectedWaitingId;
        void assignWaitingToSeat(wid, sid);
        ui.selectedSeatId = null;
        onFullRender();
      });
    });

    wrap.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSeat(btn.getAttribute("data-del"));
      });
    });

    wrap.querySelectorAll("[data-del-w]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWaiting(btn.getAttribute("data-del-w"));
      });
    });

    wrap.querySelectorAll("[data-mobile-block-w]").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        e.stopPropagation();
        const wid = cb.getAttribute("data-mobile-block-w");
        await setWaitingBlockChecked(wid, cb.checked);
      });
    });

    wrap.querySelectorAll("[data-clear-seat]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await clearSeat(btn.getAttribute("data-clear-seat"));
      });
    });
  }

  return { renderMobile };
}
