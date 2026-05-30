/**
 * Hub 대회 목록 렌더.
 * 카드 DOM: .event-card > (.event-body: .event-left + .event-center) + .event-right
 * 레이아웃·여백은 css/hub.css 의 .hub-main { --hub-* } 변수로 조절.
 */
import { escapeHtml } from "../shared/dom-utils.js";
import { getIsAdminUser, hasEventAccess, routeToTournament } from "./hub-helpers.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { prefetchPageOnce } from "../shared/page-prefetch.js";
import { prefetchIndexEventsCache } from "../index/event-cards-loaders.js";
import { hubRefs } from "./hub-dom-refs.js";
import { hubState } from "./hub-state.js";

function buildHubEmptyStateHtml(isAdmin) {
  const adminActions = isAdmin
    ? `<div class="hub-empty-actions">
        <button type="button" class="hub-empty-cta" data-hub-empty-admin>대회 추가 · 접근 관리 열기</button>
      </div>`
    : `<p class="hub-empty-muted hub-empty-muted--user">운영진이 대회를 등록하면 이곳에 카드가 표시됩니다.</p>`;

  return `
    <div class="hub-empty-state">
      <div class="hub-empty-glow" aria-hidden="true"></div>
      <div class="hub-empty-orbit" aria-hidden="true"></div>
      <p class="hub-empty-kicker">HAN Pit Hub</p>
      <h2 class="hub-empty-title">표시할 대회가 아직 없습니다</h2>
      <p class="hub-empty-lead">
        토너먼트가 등록되면 카드가 나타나고, 입장 가능한 대회는 <strong>자세히 보기</strong>로
        일정·박스 화면으로 이동할 수 있어요.
      </p>
      <ul class="hub-empty-features" aria-label="주요 기능">
        <li><span class="hub-empty-chip hub-empty-chip--gold">출석</span> 딜러 체크인 · 대기</li>
        <li><span class="hub-empty-chip hub-empty-chip--blue">배치</span> 좌석 · 대기열 운영</li>
        <li><span class="hub-empty-chip hub-empty-chip--mint">알림</span> 배치·상태 안내</li>
      </ul>
      ${adminActions}
      <div class="hub-empty-deco" aria-hidden="true">
        <span class="hub-empty-card hub-empty-card--a"></span>
        <span class="hub-empty-card hub-empty-card--b"></span>
        <span class="hub-empty-card hub-empty-card--c"></span>
      </div>
    </div>
  `;
}

function wireHubEmptyState() {
  const root = hubRefs.eventListEl;
  if (!root) return;
  const btn = root.querySelector("[data-hub-empty-admin]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    hubRefs.adminBtn?.click();
  });
}

export function showHubListLoading() {
  const { eventListEl } = hubRefs;
  if (!eventListEl) return;

  eventListEl.classList.remove("event-list--empty");
  eventListEl.classList.add("event-list--loading");
  eventListEl.innerHTML = `
    <div class="hub-loading" role="status" aria-live="polite">
      <span class="hub-loading-spinner" aria-hidden="true"></span>
      <p class="hub-loading-text">대회 목록을 불러오는 중…</p>
    </div>
  `;
}

export function renderTournaments(tournaments, userProfile, user) {
  const { eventListEl } = hubRefs;
  if (!eventListEl) return;

  const list = Array.isArray(tournaments) ? tournaments : [];

  if (!list.length && hubState.tournamentsBootstrapping && !hubState.tournamentsListReady) {
    showHubListLoading();
    return;
  }

  eventListEl.classList.remove("event-list--loading");

  if (!list.length) {
    eventListEl.classList.add("event-list--empty");
    const isAdmin = getIsAdminUser(user, userProfile);
    eventListEl.innerHTML = buildHubEmptyStateHtml(isAdmin);
    wireHubEmptyState();
    return;
  }

  eventListEl.classList.remove("event-list--empty");
  eventListEl.innerHTML = "";

  list.forEach((tournament) => {
    const enabled = hasEventAccess(userProfile, tournament, user);
    const canOps = canShowTournamentOpsUi(
      user?.email || userProfile?.email,
      userProfile,
      tournament.id,
      { id: tournament.id, name: tournament.name, logoText: tournament.logoText },
      user?.uid
    );

    const card = document.createElement("article");
    card.className = `event-card ${enabled ? "is-enabled" : "is-locked"}`;
    card.dataset.tournamentId = tournament.id;

    card.innerHTML = `
      <div class="event-body">
        <div class="event-left">${escapeHtml(tournament.logoText || "HAN")}</div>

        <div class="event-center">
          <h2 class="event-title">${escapeHtml(tournament.name)}</h2>
          <div class="event-meta">
            <div class="event-date">
              ${escapeHtml(tournament.startDate)} ~ ${escapeHtml(tournament.endDate)}
            </div>
            <div class="event-access ${enabled ? "event-access--ok" : ""}">
              ${enabled ? "접속 가능" : "허용된 계정만 입장 가능"}
              ${canOps ? ' · <strong class="event-access-ops">운영 admin</strong>' : ""}
            </div>
          </div>
        </div>
      </div>

      <div class="event-right">
        ${
          enabled
            ? `<button class="detail-btn" type="button">자세히 보기 →</button>`
            : `<div class="lock-badge">접근 제한</div>`
        }
      </div>
    `;

    if (enabled) {
      const prefetchIndex = () => {
        try {
          const u = new URL("./index.html", location.href);
          u.searchParams.set("tournamentId", tournament.id);
          prefetchPageOnce(u.href);
        } catch {
          prefetchPageOnce(
            `./index.html?tournamentId=${encodeURIComponent(tournament.id)}`
          );
        }
        void prefetchIndexEventsCache(tournament.id);
      };
      card.addEventListener("pointerenter", prefetchIndex, { passive: true });
      card.addEventListener("focusin", prefetchIndex, { passive: true });

      card.addEventListener("click", (e) => {
        e.preventDefault();
        routeToTournament(tournament.id);
      });

      const detailBtn = card.querySelector(".detail-btn");
      detailBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        routeToTournament(tournament.id);
      });
    }

    eventListEl.appendChild(card);
  });
}
