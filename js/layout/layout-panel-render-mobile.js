/**
 * layout.html: 모바일 Seat/대기 카드 UI
 */
import { LAYOUT_SEAT_DOUBLE_ACTIVATE_MS } from "./layout-core-utils.js";
import { seatShowsAlert } from "../shared/seat-alert.js";

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

  let mobileEventsWired = false;

  function layoutMobileStructureFingerprint() {
    const seats = getSortedSeats(eventState.seats);
    const displayWaiting = getWaitingListForDisplay();
    const seatPart = seats
      .map((s) => `${s.id}:${!isEmptyPerson(s.person) ? 1 : 0}`)
      .join(",");
    const waitPart = [...displayWaiting]
      .sort((a, b) => getWaitingDisplayStartMs(a) - getWaitingDisplayStartMs(b))
      .map((w) => w.id)
      .join(",");
    return `${ui.selectedWaitingId || ""}|${ui.selectedSeatId || ""}|${seatPart}|${waitPart}`;
  }

  function trySyncLayoutMobile() {
    const root = app.querySelector(".mobile");
    if (!root) return false;
    const nextFp = layoutMobileStructureFingerprint();
    if (root.getAttribute("data-layout-mobile-fp") !== nextFp) return false;

    const selectedWaiting = ui.selectedWaitingId
      ? getWaitingListForDisplay().find((w) => w.id === ui.selectedWaitingId) || null
      : null;
    const seatCard = root.querySelector(".card");
    const banner = seatCard?.querySelector(".mobile-selection-banner");
    if (selectedWaiting) {
      const html = `
        <div class="mobile-selection-banner">
          <span class="badge sel">배치할 대기</span>
          <strong>${escapeHtml(selectedWaiting.name)}</strong>
        </div>`;
      if (banner) banner.outerHTML = html.trim();
      else seatCard?.querySelector(".mobile-section-head")?.insertAdjacentHTML("afterend", html);
    } else {
      banner?.remove();
    }

    const seatById = new Map(eventState.seats.map((s) => [s.id, s]));
    root.querySelectorAll("[data-mobile-seat]").forEach((row) => {
      const sid = row.getAttribute("data-mobile-seat");
      const s = seatById.get(sid);
      if (!s) return;
      const hasPerson = !isEmptyPerson(s.person);
      const isSel = ui.selectedSeatId === sid;
      row.classList.toggle("selected", isSel);
      row.classList.toggle("seat-alert-on", seatShowsAlert(s, canManageLayout?.()));
      const personEl = row.querySelector(".mobile-seat-person");
      if (personEl) {
        personEl.textContent = isEmptyPerson(s.person) ? "비어있음" : String(s.person);
        personEl.classList.toggle("is-empty", isEmptyPerson(s.person));
        personEl.classList.toggle("is-self", hasPerson && !!isSeatMine?.(s));
      }
      const chip = row.querySelector(".time-chip[data-timer='seat']");
      if (hasPerson && chip) {
        chip.setAttribute("data-start", String(s.seatedAt || Date.now()));
      }
    });

    const waitById = new Map(getWaitingListForDisplay().map((w) => [w.id, w]));
    root.querySelectorAll("[data-mobile-wait]").forEach((row) => {
      const wid = row.getAttribute("data-mobile-wait");
      const w = waitById.get(wid);
      if (!w) return;
      const isSel = ui.selectedWaitingId === wid;
      const blocked = w.blockChecked === true;
      row.classList.toggle("selected", isSel);
      row.classList.toggle("is-blocked", blocked);
      const nameEl = row.querySelector(".mobile-wait-name");
      if (nameEl) nameEl.textContent = String(w.name || "");
      const cb = row.querySelector(".wait-block-check");
      if (cb) cb.checked = blocked;
      const chip = row.querySelector(".time-chip[data-timer='wait']");
      if (chip) chip.setAttribute("data-start", String(getWaitingDisplayStartMs(w)));
    });
    return true;
  }

  function wireLayoutMobileEventsOnce() {
    if (mobileEventsWired) return;
    mobileEventsWired = true;

    const fullRender = () => renderMobile({ forceFull: true });

    app.addEventListener("click", async (e) => {
      if (!e.target.closest(".mobile")) return;

      if (e.target.closest("#mobileAddSeatInline")) {
        addSeat();
        return;
      }
      if (e.target.closest("#mobileAddWaitingInline")) {
        const name = prompt("대기자 이름");
        if (name) addWaiting(name);
        return;
      }

      const assignBtn = e.target.closest("[data-mobile-assign]");
      if (assignBtn) {
        e.stopPropagation();
        const sid = assignBtn.getAttribute("data-mobile-assign");
        if (!ui.selectedWaitingId || !sid) return;
        void assignWaitingToSeat(ui.selectedWaitingId, sid);
        ui.selectedSeatId = null;
        fullRender();
        return;
      }

      const delBtn = e.target.closest("[data-del]");
      if (delBtn) {
        e.stopPropagation();
        deleteSeat(delBtn.getAttribute("data-del"));
        return;
      }

      const delWaitBtn = e.target.closest("[data-del-w]");
      if (delWaitBtn) {
        e.stopPropagation();
        deleteWaiting(delWaitBtn.getAttribute("data-del-w"));
        return;
      }

      const clearBtn = e.target.closest("[data-clear-seat]");
      if (clearBtn) {
        e.stopPropagation();
        await clearSeat(clearBtn.getAttribute("data-clear-seat"));
        return;
      }

      const waitRow = e.target.closest("[data-mobile-wait]");
      if (
        waitRow &&
        !e.target.closest("[data-del-w]") &&
        !e.target.closest(".wait-block-check-wrap, .wait-check-slot, input.wait-block-check")
      ) {
        const wid = waitRow.getAttribute("data-mobile-wait");
        if (!wid) return;
        ui.selectedWaitingId = wid;
        ui.selectedSeatId = null;
        fullRender();
        return;
      }

      const seatRow = e.target.closest("[data-mobile-seat]");
      if (seatRow && !e.target.closest("[data-del]") && !e.target.closest("[data-mobile-assign]") && !e.target.closest("[data-clear-seat]")) {
        const sid = seatRow.getAttribute("data-mobile-seat");
        if (!sid) return;
        const seatObj = eventState.seats.find((x) => x.id === sid);
        const occupied = seatObj && !isEmptyPerson(seatObj.person);
        const now = Date.now();

        if (ui.selectedWaitingId) {
          ui.selectedSeatId = sid;
          void assignWaitingToSeat(ui.selectedWaitingId, sid);
          ui.selectedSeatId = null;
          ui.lastMobileTapAt = 0;
          ui.lastMobileSeatId = "";
          fullRender();
          return;
        }

        if (occupied && canManageLayout()) {
          if (ui.lastMobileSeatId === sid && now - ui.lastMobileTapAt < LAYOUT_SEAT_DOUBLE_ACTIVATE_MS) {
            ui.lastMobileTapAt = 0;
            ui.lastMobileSeatId = "";
            await clearSeat(sid);
            ui.selectedSeatId = null;
            fullRender();
            return;
          }
          ui.lastMobileTapAt = now;
          ui.lastMobileSeatId = sid;
          ui.selectedSeatId = sid;
          fullRender();
          return;
        }

        ui.lastMobileTapAt = now;
        ui.lastMobileSeatId = sid;
        ui.selectedSeatId = sid;
        fullRender();
      }
    });

    app.addEventListener("change", async (e) => {
      const cb = e.target.closest("[data-mobile-block-w]");
      if (!cb) return;
      e.stopPropagation();
      await setWaitingBlockChecked(cb.getAttribute("data-mobile-block-w"), cb.checked);
    });
  }

  function renderMobile(options = {}) {
    if (!options.forceFull && options.sync !== false && trySyncLayoutMobile()) return;

    app.innerHTML = "";
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
            <div class="mobile-seat-row compact ${isSel ? "selected" : ""} ${seatShowsAlert(s, manage) ? "seat-alert-on" : ""}" data-mobile-seat="${s.id}">
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
    wrap.setAttribute("data-layout-mobile-fp", layoutMobileStructureFingerprint());
    wireLayoutMobileEventsOnce();
  }

  return { renderMobile };
}
