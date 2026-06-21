import { auth, db } from "../firebase.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { isAdminEmail } from "../app_config.js";
import { resolveStoredUserRole } from "../shared/auth-helpers.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { normalizeAndPersistUserRole } from "../login/user-sync.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { isSameAuthSession } from "../shared/auth-session-guard.js";
import { openModal, closeModal, escapeHtml } from "../shared/dom-utils.js";
import { getTournamentId, resolveRelativePage, sleep } from "./core-utils.js";
import {
  buildEventInstanceDocId,
  normalizeEventCardDate
} from "../shared/tournament-event-instance.js";
import { isTournamentActive } from "./time-utils.js";
import { IX, refreshIndexDomRefs } from "./state.js";

import {
  loadEvents,
  bindEventsRealtime,
  bindLayoutSeatSummaryRealtime,
  render,
  refreshCardStatuses,
  populateEventSelect,
  renderEventAdminList,
  syncSelectedEventForm,
  resetEventForm,
  makeNextEventDefaults,
  saveEventCard,
  deleteEventCardCurrent,
  bindMySeatAssignment
} from "./event-cards.js";
import { seedIndexEventsFromSessionCache } from "./event-cards-loaders.js";

import {
  loadDealerAttendanceOnce,
  bindDealerAttendanceRealtime,
  bindDealerSeatRealtime,
  ensureMeRecovered,
  renderDealerOps,
  updateDealerAdminList,
  scheduleRenderDealerOps,
  setupAttendanceLogEvents,
  setupWorkSummaryEvents,
  handleShowWorkSummaryClick,
  bindAttendanceLogsRealtime,
  joinSharedWaitingOnCheckIn,
  removeFromSharedWaitingOnCheckOut,
  updateMyAttendanceStatus,
  forceSelfCheckedOut,
  forceAdminCheckedOut,
  getAdminAttendanceList,
  adjustMyCheckedInAt,
  adjustMyCheckedOutAt
} from "./dealer-attendance.js";
import {
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";

import { routeToHub, initTournamentPeriodWatch } from "./tournament-period.js";

import { wireSeatMapListeners } from "./seat-map.js";
import {
  alertFcmRegistrationResult,
  bootstrapAppPush,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";
import {
  ensureDocumentShellBackground,
  instantDismissAllBootLoaders,
  markPageBootLoaded
} from "../shared/page-boot-shell.js";
import { prefetchPageOnce } from "../shared/page-prefetch.js";
import {
  bindMyUserProfileRealtime,
  disposeMyUserProfileRealtime,
  seedMyUserProfileCache
} from "../shared/bind-my-user-profile-realtime.js";
import { disposeIndexRealtimeWatches } from "./index-realtime-dispose.js";
import {
  loadUserProfileForTournamentOps,
  loadUserProfileFresh,
  raceFirestoreTimeout
} from "../shared/load-user-profile.js";
import {
  readBootUserProfile,
  readLoginProfileCache,
  isLoginProfileCacheFresh,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";

const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
void ensureForegroundFcmBadgeListener();
ensureDocumentShellBackground();
refreshIndexDomRefs();
instantDismissAllBootLoaders();
markPageBootLoaded(IX.root);

function paintIndexFromSessionEarly() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return;
  const cachedName = sessionStorage.getItem(`tournamentName:${tournamentId}`);
  if (cachedName && IX.topbarTournamentName) {
    IX.topbarTournamentName.textContent = cachedName;
  }
  if (seedIndexEventsFromSessionCache()) {
    render();
    refreshCardStatuses();
  }
}
paintIndexFromSessionEarly();

function resolveGlobalLayoutEventContext() {
  const selectedDocId = String(IX.eventCardSelect?.value || "").trim();
  const selected = selectedDocId
    ? IX.events.find((ev) => String(ev.id || "") === selectedDocId)
    : null;
  if (selected?.id && selected?.boxId) {
    return { eventId: selected.id, boxId: selected.boxId };
  }

  const cardId = String(IX.eventCardId?.value || "").trim();
  const boxId = String(IX.eventCardBoxId?.value || "").trim();
  const date = normalizeEventCardDate(IX.eventCardDate?.value || "");
  if (date && cardId && boxId) {
    const docId = buildEventInstanceDocId(date, cardId, boxId);
    const match = docId ? IX.events.find((ev) => String(ev.id || "") === docId) : null;
    if (match?.id && match?.boxId) {
      return { eventId: match.id, boxId: match.boxId };
    }
  }

  return { eventId: cardId, boxId };
}

function buildGlobalLayoutHref() {
  const tournamentId = getTournamentId();
  if (!tournamentId) return "";
  const q = new URLSearchParams();
  q.set("tournamentId", tournamentId);
  const { eventId, boxId } = resolveGlobalLayoutEventContext();
  if (eventId && boxId) {
    q.set("eventId", eventId);
    q.set("boxId", boxId);
  }
  return `./global-layout.html?${q.toString()}`;
}

let indexHadOps = false;
let indexOpsVerified = false;
/** onAuthStateChanged·모바일 토큰 갱신 시 이전 init 이 리스너를 중복 등록하지 않도록 */
let indexAuthFlowGen = 0;
let indexSessionUid = "";
let indexOpsResyncTimer = 0;

function indexTournamentMeta() {
  const t = IX.currentTournament;
  if (t?.id) return { id: t.id, name: t.name, logoText: t.logoText };
  const tid = getTournamentId();
  if (!tid) return null;
  const cachedName = sessionStorage.getItem(`tournamentName:${tid}`);
  if (cachedName) return { id: tid, name: cachedName, logoText: "" };
  return { id: tid };
}

function resolveIndexBootProfile(user) {
  if (!user?.uid) return null;
  const hadCache = !!readLoginProfileCache(user.uid);
  return {
    profile: readBootUserProfile(user),
    fromCache: hadCache,
    stale: hadCache && !isLoginProfileCacheFresh(user.uid)
  };
}

function applyIndexBootProfile(user) {
  if (!user?.uid) return null;
  const loginCached = readLoginProfileCache(user.uid);
  if (loginCached) {
    IX.currentUserProfile = loginCached;
    seedMyUserProfileCache(loginCached);
    applyIndexOpsPermissions(user, { fromCache: true });
    return {
      profile: loginCached,
      fromCache: true,
      stale: !isLoginProfileCacheFresh(user.uid)
    };
  }
  const boot = resolveIndexBootProfile(user);
  if (!boot?.profile) return null;
  IX.currentUserProfile = boot.profile;
  seedMyUserProfileCache(boot.profile);
  applyIndexOpsPermissions(user, { fromCache: boot.fromCache });
  return boot;
}

async function loadIndexUserProfile(user) {
  if (!user?.uid) return null;
  return loadUserProfileForTournamentOps(user.uid, user.email || "", getTournamentId(), {
    preferCacheFirst: true,
    tournamentMeta: indexTournamentMeta()
  });
}

function indexOpsAccessOk(user = auth.currentUser) {
  const tid = getTournamentId();
  if (!tid || !user) return false;
  return canShowTournamentOpsUi(
    user.email || "",
    IX.currentUserProfile,
    tid,
    indexTournamentMeta(),
    user.uid
  );
}

/** 모바일·PWA — Firestore 지연 시 운영 UI 가 늦게 켜지는 것 재시도 */
async function ensureIndexOpsChrome(user = auth.currentUser) {
  if (!user?.uid) return;
  applyIndexOpsPermissions(user);
  if (indexOpsAccessOk(user)) return;

  const cached = await raceFirestoreTimeout(
    loadUserProfileFresh(user.uid, user.email || "", {
      preferCacheFirst: true,
      skipLoginCache: false
    }),
    5000
  );
  if (cached) {
    IX.currentUserProfile = cached;
    seedMyUserProfileCache(cached);
    writeLoginProfileCache(user.uid, cached);
    applyIndexOpsPermissions(user);
    if (indexOpsAccessOk(user)) return;
  }

  if (isLoginProfileCacheFresh(user.uid) && indexOpsAccessOk(user)) return;

  const profile = await raceFirestoreTimeout(loadIndexUserProfile(user), 8000);
  if (profile) {
    IX.currentUserProfile = profile;
    seedMyUserProfileCache(profile);
    writeLoginProfileCache(user.uid, profile);
  }
  applyIndexOpsPermissions(user);
}

function tryEarlyIndexChromePaint() {
  const user = auth.currentUser;
  if (!user) return;
  refreshIndexDomRefs();
  applyIndexBootProfile(user);
}

function applyIndexOpsPermissions(user = auth.currentUser, meta = {}) {
  if (!user) return;

  const tid = getTournamentId();
  const email = user.email || "";
  const canOps = canShowTournamentOpsUi(
    email,
    IX.currentUserProfile,
    tid,
    indexTournamentMeta(),
    user.uid
  );

  indexHadOps = canOps;
  renderDealerOps();

  if (canOps) {
    indexOpsVerified = true;
    IX.globalLayoutBtn?.classList.remove("hidden");
    IX.seatMapOpenEditorBtn?.classList.remove("hidden");
    IX.eventAdminBtn?.classList.remove("hidden");
    IX.attendanceLogBtn?.classList.remove("hidden");
    if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "1";
    return;
  }

  if (indexOpsVerified) {
    return;
  }

  IX.globalLayoutBtn?.classList.add("hidden");
  IX.seatMapOpenEditorBtn?.classList.add("hidden");
  IX.eventAdminBtn?.classList.add("hidden");
  IX.attendanceLogBtn?.classList.add("hidden");
  if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "0";
}

async function refreshIndexOpsFromServer(user = auth.currentUser) {
  if (!user?.uid) return;
  try {
    const profile = await loadIndexUserProfile(user);
    if (profile) {
      IX.currentUserProfile = profile;
      seedMyUserProfileCache(profile);
    }
    const hadOps = indexHadOps;
    applyIndexOpsPermissions(user);
    if (getTournamentId() && hadOps !== indexHadOps) {
      bindDealerAttendanceRealtime();
      await loadDealerAttendanceOnce();
    }
  } catch (err) {
    console.warn("refreshIndexOpsFromServer:", err);
  }
}

async function init() {
  refreshIndexDomRefs();
  markPageBootLoaded(IX.root);

  const bootTournamentId = getTournamentId();
  if (!bootTournamentId) {
    const hubHref = resolveRelativePage("hub.html");
    if (IX.root) {
      IX.root.innerHTML = `
        <section class="index-boot-card" role="status">
          <h2 class="index-boot-title">대회가 선택되지 않았습니다</h2>
          <p class="index-boot-desc">
            URL에 <code>tournamentId</code>가 없거나 세션이 비어 있습니다.
            허브에서 대회 카드를 눌러 들어오거나 아래 버튼으로 이동해 주세요.
          </p>
          <a class="manage-btn index-boot-btn" href="${escapeHtml(hubHref)}">Han Pit 허브로 이동</a>
        </section>`;
    }
    return;
  }

  sessionStorage.setItem("tournamentId", bootTournamentId);

  const paintedFromSession = seedIndexEventsFromSessionCache();
  if (paintedFromSession) {
    render();
  }

  renderDealerOps();

  bindEventsRealtime(bootTournamentId);
  bindLayoutSeatSummaryRealtime(bootTournamentId);
  bindDealerAttendanceRealtime();
  bindDealerSeatRealtime();

  await loadEvents(bootTournamentId, { forceServer: true });

  void ensureMeRecovered(auth.currentUser)
    .catch((err) => {
      console.error("ensureMeRecovered error:", err);
    })
    .finally(() => {
      scheduleRenderDealerOps();
    });

  render();
  renderDealerOps();
  refreshCardStatuses();

  setupAttendanceLogEvents();
  setupWorkSummaryEvents();

  applyIndexOpsPermissions(auth.currentUser);
  IX.indexBootComplete = true;
}

function wireIndexPageControls() {
  refreshIndexDomRefs();

  IX.dealerOpsMount?.addEventListener("click", (e) => {
    const chip = e.target.closest(".dealer-time-chip--editable");
    if (!chip || e.target.closest(".dealer-time-chip-input")) return;
    const input = chip.querySelector("[data-edit-check-in],[data-edit-check-out]");
    if (!input) return;
    input.focus();
    try {
      if (typeof input.showPicker === "function") input.showPicker();
    } catch (_) {
      /* iOS 구버전: focus만으로 네이티브 피커 */
    }
  });

  IX.dealerOpsMount?.addEventListener("change", async (e) => {
    const user = auth.currentUser;
    if (!user) return;

    const checkInInput = e.target.closest("[data-edit-check-in]");
    const checkOutInput = e.target.closest("[data-edit-check-out]");
    if (!checkInInput && !checkOutInput) return;

    try {
      const ok = checkOutInput
        ? await adjustMyCheckedOutAt(new Date(checkOutInput.value).getTime())
        : await adjustMyCheckedInAt(new Date(checkInInput.value).getTime());
      if (ok) {
        await loadDealerAttendanceOnce();
        renderDealerOps();
      }
    } catch (err) {
      console.error("adjust attendance time change error:", err);
    }
  });

  IX.root?.addEventListener("click", (e) => {
    const card = e.target.closest(".event-card");
    if (!card) return;

    if (IX.currentTournament && !isTournamentActive(IX.currentTournament)) {
      routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
      return;
    }

    const tournamentId = getTournamentId();
    const eventId = card.dataset.eventId;
    const boxId = card.dataset.boxId;

    if (!eventId || !boxId) {
      console.warn("❌ Missing eventId or boxId");
      return;
    }

    sessionStorage.setItem("tournamentId", tournamentId);
    sessionStorage.setItem("eventId", eventId);
    sessionStorage.setItem("boxId", boxId);

    location.href = `./layout.html?tournamentId=${encodeURIComponent(tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}`;
  });

  IX.backBtn?.addEventListener("click", () => {
    sessionStorage.removeItem("boxId");
    location.href = resolveRelativePage("hub.html");
  });

  const prefetchGlobalLayout = () => {
    const href = buildGlobalLayoutHref();
    if (href) prefetchPageOnce(href);
  };
  IX.globalLayoutBtn?.addEventListener("pointerenter", prefetchGlobalLayout, { passive: true });
  IX.globalLayoutBtn?.addEventListener("focus", prefetchGlobalLayout, { passive: true });

  IX.globalLayoutBtn?.addEventListener("click", () => {
    const tournamentId = getTournamentId();
    if (!tournamentId) {
      alert("대회 정보가 없습니다.");
      return;
    }
    sessionStorage.setItem("tournamentId", tournamentId);
    const { eventId, boxId } = resolveGlobalLayoutEventContext();
    if (eventId && boxId) {
      sessionStorage.setItem("eventId", eventId);
      sessionStorage.setItem("boxId", boxId);
    }
    const href = buildGlobalLayoutHref();
    if (href) location.href = href;
  });

  IX.eventAdminBtn?.addEventListener("click", () => {
    populateEventSelect();
    renderEventAdminList();
    openModal(IX.eventAdminModal);
    void loadEvents().then(() => {
      populateEventSelect();
      renderEventAdminList();
    });
  });

  IX.closeEventAdminBtn?.addEventListener("click", () => {
    closeModal(IX.eventAdminModal);
  });

  IX.eventAdminModal?.addEventListener("click", (e) => {
    if (e.target === IX.eventAdminModal) {
      closeModal(IX.eventAdminModal);
    }
  });

  IX.eventCardSelect?.addEventListener("change", syncSelectedEventForm);

  IX.newEventCardBtn?.addEventListener("click", () => {
    resetEventForm();
    makeNextEventDefaults();
  });

  IX.saveEventCardBtn?.addEventListener("click", saveEventCard);
  IX.deleteEventCardBtn?.addEventListener("click", deleteEventCardCurrent);

  IX.eventCardList?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pick-id]");
    if (!btn) return;

    IX.eventCardSelect.value = btn.dataset.pickId;
    syncSelectedEventForm();
  });

  IX.dealerOpsMount?.addEventListener("compositionstart", (e) => {
    if (e.target.closest("[data-dealer-search]")) {
      IX.dealerSearchComposing = true;
    }
  });

  IX.dealerOpsMount?.addEventListener("compositionend", (e) => {
    const searchEl = e.target.closest("[data-dealer-search]");
    if (!searchEl) return;

    IX.dealerSearchComposing = false;
    IX.dealerAdminUi.search = String(searchEl.value || "");
    updateDealerAdminList();
  });

  IX.dealerOpsMount?.addEventListener("input", (e) => {
    const searchEl = e.target.closest("[data-dealer-search]");
    if (!searchEl) return;
    if (IX.dealerSearchComposing) return;

    IX.dealerAdminUi.search = String(searchEl.value || "");
    updateDealerAdminList();
  });

  IX.dealerOpsMount?.addEventListener("change", (e) => {
    const filterEl = e.target.closest("[data-dealer-filter]");
    if (filterEl) {
      IX.dealerAdminUi.status = String(filterEl.value || "all");
      updateDealerAdminList();
      return;
    }

    const sortEl = e.target.closest("[data-dealer-sort]");
    if (sortEl) {
      IX.dealerAdminUi.sort = String(sortEl.value || "name");
      updateDealerAdminList();
    }
  });

  IX.dealerOpsMount?.addEventListener("click", async (e) => {
    try {
      const toggleBtn = e.target.closest("[data-dealer-toggle]");
      if (toggleBtn) {
        IX.dealerUiCollapsed = !IX.dealerUiCollapsed;
        renderDealerOps();
        return;
      }

      const user = auth.currentUser;
      const tid = getTournamentId();

      const selfBtn = e.target.closest("[data-self-action]");
      if (selfBtn && user) {
        const action = String(selfBtn.getAttribute("data-self-action") || "").trim();
        if (!action) return;

        if (action === "waiting") {
          const prevSnap = snapshotAttendanceEntry(tid, user.uid);
          try {
            await updateMyAttendanceStatus("waiting", { optimistic: true });
          } catch (err) {
            console.error("updateMyAttendanceStatus(waiting):", err);
            alert(
              String(err?.code || "") === "permission-denied"
                ? "출근 기록 저장 권한이 없습니다. 다시 로그인해 주세요."
                : "출근 기록 저장에 실패했습니다."
            );
            return;
          }

          void (async () => {
            const joinResult = await joinSharedWaitingOnCheckIn(user);
            const ok = joinResult === true || joinResult?.ok === true;
            if (!ok) {
              restoreAttendanceSnapshot(tid, user.uid, prevSnap);
              void loadDealerAttendanceOnce();
              return;
            }
            void loadDealerAttendanceOnce();
          })();
          return;
        }

        if (action === "checked_out") {
          try {
            await forceSelfCheckedOut(user);
          } catch (err) {
            console.error("forceSelfCheckedOut:", err);
            alert("퇴근 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.");
          }
          return;
        }
      }

      const summaryBtn = e.target.closest("[data-show-work-summary]");
      if (summaryBtn && user) {
        handleShowWorkSummaryClick();
        return;
      }

      const canOps = canShowTournamentOpsUi(
        user?.email,
        IX.currentUserProfile,
        tid,
        indexTournamentMeta(),
        user?.uid
      );

      if (canOps) {
        const adminBtn = e.target.closest("[data-admin-action]");
        if (adminBtn) {
          const action = String(adminBtn.getAttribute("data-admin-action") || "").trim();
          const uid = String(adminBtn.getAttribute("data-admin-uid") || "").trim();

          if (!action || !uid) return;

          if (action === "checked_out") {
            const target = getAdminAttendanceList().find((item) => String(item.uid || "").trim() === uid);
            if (!target) return;

            await forceAdminCheckedOut(target);
            void loadDealerAttendanceOnce();
          }
        }
      }
    } catch (err) {
      console.error("dealerOps click error:", err);
    }
  });

  try {
    wireSeatMapListeners();
  } catch (err) {
    console.error("wireSeatMapListeners (index) error:", err);
  }

  bindIndexPushUiOnce();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireIndexPageControls, { once: true });
  document.addEventListener("DOMContentLoaded", tryEarlyIndexChromePaint, { once: true });
} else {
  wireIndexPageControls();
  tryEarlyIndexChromePaint();
}

function bindIndexPushUiOnce() {
  const btn = IX.enablePushBtn;
  if (!btn || btn.dataset.indexPushBound === "1") return;
  btn.dataset.indexPushBound = "1";
  btn.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (!u?.uid) {
      alert("로그인을 확인하는 중입니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    const r = await registerFcmWebPushAndSave(u.uid);
    alertFcmRegistrationResult(r);
    syncPushOfferButton(btn, u.uid);
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    indexSessionUid = "";
    indexAuthFlowGen += 1;
    indexHadOps = false;
  indexOpsVerified = false;
    disposeIndexRealtimeWatches();
    location.replace("./login.html");
    return;
  }

  if (isSameAuthSession(indexSessionUid, user)) {
    void bootstrapAppPush(user.uid);
    return;
  }

  indexSessionUid = user.uid;
  const flow = ++indexAuthFlowGen;
  disposeIndexRealtimeWatches();
  bindMySeatAssignment(user);

  try {
    refreshIndexDomRefs();

    const userRef = doc(db, "users", user.uid);
    IX.indexBootComplete = false;

    const boot = applyIndexBootProfile(user);
    if (boot) {
      bindMyUserProfileRealtime(user.uid, {
        email: user.email || "",
        onProfileChange: (profile, meta) => {
          IX.currentUserProfile = profile;
          applyIndexOpsPermissions(user, meta);
        }
      });
      syncPushOfferButton(IX.enablePushBtn, user.uid);
      void bootstrapAppPush(user.uid);
      flushAppBadgeIfVisible();
    }

    const profilePromise = (async () => {
      if (flow !== indexAuthFlowGen) return null;
      let profile = await raceFirestoreTimeout(
        loadUserProfileFresh(user.uid, user.email || "", {
          preferCacheFirst: true,
          mergeEmailAllows: true
        }),
        4000
      );
      if (!profile) {
        IX.currentUserProfile = {
          email: user.email || "",
          nickname: user.displayName || "",
          role: resolveStoredUserRole(user.email || "", {}),
          accessCode: ""
        };
        await setDoc(
          userRef,
          {
            email: user.email || "",
            nickname: user.displayName || "",
            role: IX.currentUserProfile.role,
            accessCode: ""
          },
          { merge: true }
        );
        profile = IX.currentUserProfile;
      } else {
        IX.currentUserProfile = profile;
        void normalizeAndPersistUserRole(user.uid, IX.currentUserProfile, user.email || "").then(
          (normalized) => {
            if (normalized) {
              IX.currentUserProfile = normalized;
              applyIndexOpsPermissions(user);
            }
          }
        );
      }
      seedMyUserProfileCache(IX.currentUserProfile);
      writeLoginProfileCache(user.uid, IX.currentUserProfile);
      if (!boot) {
        bindMyUserProfileRealtime(user.uid, {
          email: user.email || "",
          onProfileChange: (p, meta) => {
            IX.currentUserProfile = p;
            applyIndexOpsPermissions(user, meta);
          }
        });
        syncPushOfferButton(IX.enablePushBtn, user.uid);
        void bootstrapAppPush(user.uid);
        flushAppBadgeIfVisible();
      }
      applyIndexOpsPermissions(user);
      return profile;
    })();

    await init();
    if (flow !== indexAuthFlowGen) return;
    await initTournamentPeriodWatch();
    void profilePromise
      .then(() => ensureIndexOpsChrome(user))
      .catch(() => null);
    void refreshIndexOpsFromServer(user);
  } catch (err) {
    console.error("index auth init error:", err);
    alert("인덱스 데이터를 불러오지 못했습니다.");
  }
});

window.addEventListener("hanpit-index-tournament-ready", () => {
  applyIndexOpsPermissions(auth.currentUser);
  if (IX.events.length) {
    render();
    refreshCardStatuses();
  }
  if (!indexOpsAccessOk(auth.currentUser)) {
    void ensureIndexOpsChrome(auth.currentUser);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (indexOpsAccessOk(auth.currentUser)) return;
  window.clearTimeout(indexOpsResyncTimer);
  indexOpsResyncTimer = window.setTimeout(() => {
    indexOpsResyncTimer = 0;
    void ensureIndexOpsChrome(auth.currentUser);
  }, 300);
});

setInterval(() => {
  refreshCardStatuses();
}, 30000);

setInterval(() => {
  if (IX.currentTournament && !isTournamentActive(IX.currentTournament)) {
    routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
  }
}, 60000);

window.addEventListener("beforeunload", () => {
  disposeIndexRealtimeWatches();
});
