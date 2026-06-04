import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { GL } from "./state.js";

function ensurePcOpsDivider(splitEl) {
  if (!splitEl || splitEl.querySelector(".global-pc-ops-divider")) return;
  const seatCol = splitEl.querySelector(".global-pc-ops-col--seat");
  if (!seatCol) return;
  const divider = document.createElement("div");
  divider.className = "global-pc-ops-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-hidden", "true");
  seatCol.before(divider);
}

export function ensurePcOpsSplitShell() {
  if (layoutIsMobile() || !GL.panelContent) return false;
  const existing = GL.panelContent.querySelector("#globalPcOpsSplit");
  if (existing) {
    ensurePcOpsDivider(existing);
    return true;
  }
  GL.panelContent.innerHTML = `
    <div id="globalPcOpsSplit" class="global-pc-ops-split">
      <section class="global-pc-ops-col global-pc-ops-col--wait" aria-label="대기">
        <div class="global-pc-ops-col__head"><h3>대기</h3></div>
        <div class="global-pc-ops-col__body" data-pc-col="wait"></div>
      </section>
      <div class="global-pc-ops-divider" role="separator" aria-hidden="true"></div>
      <section class="global-pc-ops-col global-pc-ops-col--seat" aria-label="Seat">
        <div class="global-pc-ops-col__head"><h3>Seat</h3></div>
        <div class="global-pc-ops-col__body" data-pc-col="seat"></div>
      </section>
    </div>
  `;
  return true;
}

export function getPcWaitColEl() {
  if (layoutIsMobile() || !GL.panelContent) return null;
  ensurePcOpsSplitShell();
  return GL.panelContent.querySelector('[data-pc-col="wait"]');
}

export function getPcSeatColEl() {
  if (layoutIsMobile() || !GL.panelContent) return null;
  ensurePcOpsSplitShell();
  return GL.panelContent.querySelector('[data-pc-col="seat"]');
}

export function getPcWaitScrollEl() {
  return getPcWaitColEl()?.querySelector("[data-pc-scroll='wait']") || null;
}

export function getPcSeatScrollEl() {
  return getPcSeatColEl()?.querySelector("[data-pc-scroll='seat']") || null;
}
