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

async function bootstrapPayrollPage(user) {
  const tournamentId = ensureTournamentContextOrAlert();
  if (!tournamentId) return;

  sessionStorage.setItem("tournamentId", tournamentId);
  seedIndexTournamentMetaFromHubCache();
  syncPayrollTopbarTitle();

  await loadPayrollUserProfile(user);
  if (!canAccessPayrollPage(user)) {
    showPayrollDenied();
    return;
  }

  await Promise.all([loadDealerAttendanceOnce(), loadTournamentDealerRosterOnce()]);

  const bodyEl = document.getElementById("payrollTableBody");
  const searchEl = document.getElementById("payrollTableSearch");
  if (!bodyEl) return;

  const table = createPayrollTableView({ bodyEl, searchEl });
  await table.loadPayrollTable();
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
