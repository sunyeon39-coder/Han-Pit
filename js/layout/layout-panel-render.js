/**
 * layout.html: 모바일 카드 UI + PC 우측 대기/Seat 패널 DOM 렌더
 * 구현은 layout-panel-render-mobile.js / layout-panel-render-pc.js 에 분리.
 */
import { createLayoutMobilePanelRender } from "./layout-panel-render-mobile.js";
import { createLayoutPcPanelRender } from "./layout-panel-render-pc.js";

export function createLayoutPanelRenderers(deps) {
  const { renderMobile } = createLayoutMobilePanelRender(deps);
  const { renderWaitPanel, renderSeatPanel } = createLayoutPcPanelRender(deps);
  return { renderMobile, renderWaitPanel, renderSeatPanel };
}
