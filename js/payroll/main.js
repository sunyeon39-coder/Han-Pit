import { auth } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  ensureTournamentContextOrAlert,
  getTournamentId,
  resolveRelativePage
} from "../index/core-utils.js";
import { IX } from "../index/state.js";
import { seedIndexTournamentMetaFromHubCache } from "../index/index-ops-bootstrap.js";
import { loadDealerAttendanceOnce } from "../index/dealer-attendance-load-once.js";
import { loadTournamentDealerRosterOnce } from "../index/dealer-attendance-roster.js";
import { createPayrollTableView } from "../index/dealer-payroll-table.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import {
  isLoginProfileCacheFresh,
  readBootUserProfile,
  readLoginProfileCache,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";
import { loadUserProfileForTournamentOps } from "../shared/load-user-profile.js";
import { seedMyUserProfileCache } from "../shared/bind-my-user-profile-realtime.js";
import { ensureDocumentShellBackground, markPageBootLoaded } from "../shared/page-boot-shell.js";
import { isSameAuthSession } from "../shared/auth-session-guard.js";

function payrollTournamentMeta() {
  const t = IX.currentTournament;
  if (t?.id) return { id: t.id, name: t.name, logoText: t.logoText };
  const tid = getTournamentId();
  if (!tid) return null;
  const cachedName = sessionStorage.getItem(`tournamentName:${tid}`);
  if (cachedName) return { id: tid, name: cachedName, logoText: "" };
  return { id: tid };
}

function syncPayrollTopbarTitle() {
  const titleEl = document.getElementById("topbarTournamentName");
  if (!titleEl) return;
  const meta = payrollTournamentMeta();
  const name = String(meta?.name || getTournamentId() || "인건비").trim();
  titleEl.textContent = `${name} · 인건비`;
}

function showPayrollDenied(message = "운영 권한이 필요합니다.") {
  const body = document.getElementById("payrollTableBody");
  if (!body) return;
  body.innerHTML = `<p class="payroll-page-denied">${message}</p>`;
}

async function loadPayrollUserProfile(user) {
  if (!user?.uid) return null;

  const cached = readLoginProfileCache(user.uid);
  if (cached) {
    IX.currentUserProfile = cached;
    seedMyUserProfileCache(cached);
    if (isLoginProfileCacheFresh(user.uid)) return cached;
  }

  const boot = readBootUserProfile(user);
  if (boot) {
    IX.currentUserProfile = boot;
    seedMyUserProfileCache(boot);
  }

  const profile = await loadUserProfileForTournamentOps(
    user.uid,
    user.email || "",
    getTournamentId(),
    { preferCacheFirst: true, tournamentMeta: payrollTournamentMeta() }
  );
  if (profile) {
    IX.currentUserProfile = profile;
    seedMyUserProfileCache(profile);
    writeLoginProfileCache(user.uid, profile);
  }
  return IX.currentUserProfile;
}

function canAccessPayrollPage(user) {
  return canShowTournamentOpsUi(
    user?.email || "",
    IX.currentUserProfile,
    getTournamentId(),
    payrollTournamentMeta(),
    user?.uid
  );
}

function wirePayrollPageNav() {
  document.getElementById("backBtn")?.addEventListener("click", () => {
    const tournamentId = getTournamentId();
    if (tournamentId) {
      location.href = `./index.html?tournamentId=${encodeURIComponent(tournamentId)}`;
      return;
    }
    location.href = resolveRelativePage("hub.html");
  });
}

/**
 * 속도 개선: 권한 확인(loadPayrollUserProfile)과 데이터 로딩(출석·로스터·로그·인건비설정)을
 * 동시에 시작합니다. 서로 결과가 필요 없는 독립적인 Firestore 조회이기 때문에, 이전처럼
 * "프로필 확인 → 출석/로스터 → 로그/인건비설정" 순서로 기다리지 않고 한 번에 병렬로 실행해
 * 첫 화면이 뜨기까지의 시간을 단축합니다. 권한이 없는 것으로 확인되면 미리 받아둔 데이터는
 * 그냥 버립니다(화면에 그리지 않음).
 */
async function bootstrapPayrollPage(user) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;

  sessionStorage.setItem("tournamentId", tournamentId);
  seedIndexTournamentMetaFromHubCache();
  syncPayrollTopbarTitle();

  const bodyEl = document.getElementById("payrollTableBody");
  const searchEl = document.getElementById("payrollTableSearch");
  const exportEl = document.getElementById("payrollExportBtn");
  const tabsEl = document.getElementById("payrollViewTabs");
  if (!bodyEl) return;

  const table = createPayrollTableView({ bodyEl, searchEl, exportEl, tabsEl });
  table.setLoading();

  const profilePromise = loadPayrollUserProfile(user);
  const dataPromise = Promise.all([
    loadDealerAttendanceOnce(),
    loadTournamentDealerRosterOnce(),
    table.prefetchPayrollData(tournamentId)
  ]);

  await profilePromise;
  if (!canAccessPayrollPage(user)) {
    showPayrollDenied();
    return;
  }

  await dataPromise;
  await table.loadPayrollTable();
  table.bindExportButton(document.getElementById("payrollExportBtn"));
}

(() => {
  "use strict";

  let payrollSessionUid = "";

  ensureDocumentShellBackground();
  markPageBootLoaded(document.querySelector(".payroll-page"));
  wirePayrollPageNav();

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      payrollSessionUid = "";
      location.replace(resolveRelativePage("login.html"));
      return;
    }

    if (isSameAuthSession(payrollSessionUid, user)) return;

    payrollSessionUid = user.uid;
    void bootstrapPayrollPage(user);
  });
})();
