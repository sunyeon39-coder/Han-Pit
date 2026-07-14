/**
 * layout.html: 루트 app / 우측 패널 DOM 갱신
 */
export function createLayoutUiRender(deps) {
  const {
    app,
    panelContent,
    tabs,
    ui,
    mobileSheet,
    isMobile,
    layoutPanels,
    layoutCanvas,
    layoutTimers
  } = deps;

  function renderBoxPanel() {
    panelContent.innerHTML = `
      <div class="panel-title">박스</div>
      <div class="row">
        <div class="left">
          <div style="font-weight:900;">준비중</div>
        </div>
      </div>
    `;
  }

  function renderPanel() {
    if (isMobile()) return;

    tabs.forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === ui.activeTab);
    });

    if (ui.activeTab === "wait") {
      layoutPanels.renderWaitPanel();
    } else if (ui.activeTab === "seat") {
      layoutPanels.renderSeatPanel();
    } else {
      renderBoxPanel();
    }
  }

  function renderCanvasOnly() {
    if (isMobile()) return false;
    if (typeof layoutCanvas.syncCanvas === "function" && layoutCanvas.syncCanvas()) {
      layoutTimers.updateTimers();
      return true;
    }
    return false;
  }

  function render() {
    if (isMobile()) {
      layoutPanels.renderMobile({ sync: true });
      layoutTimers.updateTimers();
      mobileSheet?.classList.remove("open");
      return;
    }

    if (!renderCanvasOnly()) {
      app.innerHTML = "";
      app.appendChild(layoutCanvas.buildCanvas());
    }
    renderPanel();
    layoutTimers.updateTimers();
  }

  return { render, renderCanvasOnly, renderPanel, renderBoxPanel };
}
