/**
 * layout.html main IIFE: 메뉴·뒤로가기·탭·모바일 FAB·키보드·오디오 잠금 등 DOM 이벤트 연결
 */
export function setupLayoutMainDomWiring(deps) {
  const {
    menuBtn,
    backBtn,
    pcPanel,
    mobileSheet,
    mobileAddSeatBtn,
    mobileAddWaitingBtn,
    tabs,
    isMobile,
    TOURNAMENT_ID,
    canManageLayout,
    addSeat,
    addWaiting,
    deleteSeat,
    deleteWaiting,
    ui,
    render,
    renderPanel,
    layoutTimers,
    seatNotify
  } = deps;

  if (menuBtn) {
    menuBtn.onclick = () => {
      if (isMobile()) {
        pcPanel?.classList.remove("open");
        mobileSheet?.classList.toggle("open");
      } else {
        mobileSheet?.classList.remove("open");
        pcPanel?.classList.toggle("open");
      }
    };
  }

  window.addEventListener("resize", () => {
    if (isMobile()) {
      pcPanel?.classList.remove("open");
    } else {
      mobileSheet?.classList.remove("open");
    }
    render();
  });

  if (backBtn) {
    backBtn.onclick = () => {
      if (TOURNAMENT_ID) {
        sessionStorage.setItem("tournamentId", TOURNAMENT_ID);
        location.href = `./index.html?tournamentId=${encodeURIComponent(TOURNAMENT_ID)}`;
        return;
      }

      sessionStorage.removeItem("eventId");
      sessionStorage.removeItem("boxId");
      location.href = "./hub.html";
    };
  }

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      ui.activeTab = t.dataset.tab;
      if (ui.activeTab === "wait") {
        ui.selectedSeatId = null;
      }
      renderPanel();
      layoutTimers.updateTimers();
    });
  });

  if (mobileAddSeatBtn) {
    mobileAddSeatBtn.style.display = canManageLayout() ? "" : "none";
    mobileAddSeatBtn.onclick = () => {
      if (!canManageLayout()) return;
      addSeat();
      mobileSheet?.classList.remove("open");
    };
  }

  if (mobileAddWaitingBtn) {
    mobileAddWaitingBtn.style.display = canManageLayout() ? "" : "none";
    mobileAddWaitingBtn.onclick = () => {
      if (!canManageLayout()) return;
      const name = prompt("대기자 이름");
      if (name) addWaiting(name);
      mobileSheet?.classList.remove("open");
    };
  }

  window.addEventListener("keydown", (e) => {
    if (!canManageLayout()) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;

    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (ui.selectedWaitingId) {
      deleteWaiting(ui.selectedWaitingId);
      return;
    }

    if (ui.selectedSeatId) {
      deleteSeat(ui.selectedSeatId);
      return;
    }
  });

  ["click", "touchstart", "keydown"].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        void seatNotify.unlockAudio();
      },
      { once: true }
    );
  });
}
