/**
 * Hub 페이지 — 구현은 ./hub/main.js
 */
import "./shared/pwa-update-reload.js";
import "./shared/add-to-home-hint.js";

function showHubBootError(err) {
  console.error("[hub] boot failed:", err);
  const el = document.getElementById("eventList");
  if (!el) return;
  el.classList.add("event-list--empty");
  el.innerHTML = `
    <div class="hub-empty-state">
      <h2 class="hub-empty-title">허브를 불러오지 못했습니다</h2>
      <p class="hub-empty-lead">새로고침 후 다시 시도해 주세요. (${escapeHtml(String(err?.message || err || "unknown"))})</p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import("./hub/main.js").catch(showHubBootError);
