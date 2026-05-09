import { auth, db } from "../firebase.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { isAdminEmail } from "../app_config.js";
import { getIsAdmin } from "../shared/auth-helpers.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { openModal, closeModal, escapeHtml } from "../shared/dom-utils.js";
import { getTournamentId, resolveRelativePage } from "./core-utils.js";
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

import {
  loadDealerAttendanceOnce,
  bindDealerAttendanceRealtime,
  bindDealerSeatRealtime,
  ensureMeRecovered,
  renderDealerOps,
  setupAttendanceLogEvents,
  bindAttendanceLogsRealtime,
  joinSharedWaitingOnCheckIn,
  removeFromSharedWaitingOnCheckOut,
  updateMyAttendanceStatus,
  forceSelfCheckedOut,
  forceAdminCheckedOut,
  getAdminAttendanceList
} from "./dealer-attendance.js";

import { routeToHub, initTournamentPeriodWatch } from "./tournament-period.js";

import { wireSeatMapListeners } from "./seat-map.js";
import {
  alertFcmRegistrationResult,
  ensureForegroundFcmBadgeListener,
  registerFcmWebPushAndSave,
  refreshFcmTokenIfGranted,
  syncPushOfferButton
} from "../shared/fcm-web-push.js";
import { bindAppBadgeClearOnForeground } from "../shared/app-badge-sync.js";

const flushAppBadgeIfVisible = bindAppBadgeClearOnForeground(db, auth);
void ensureForegroundFcmBadgeListener();

async function init() {
  refreshIndexDomRefs();

  if (!getTournamentId()) {
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
    setTimeout(() => {
      if (!getTournamentId()) {
        location.href = hubHref;
      }
    }, 400);
    return;
  }

  /* Firestore 대기 전에도 목록 영역·딜러 패널을 먼저 그려 빈 화면을 줄입니다. */
  render();
  renderDealerOps();

  await loadEvents();

  bindEventsRealtime();
  bindLayoutSeatSummaryRealtime();

  await loadDealerAttendanceOnce();
  bindDealerAttendanceRealtime();
  bindDealerSeatRealtime();

  try {
    await ensureMeRecovered(auth.currentUser);
  } catch (err) {
    console.error("ensureMeRecovered error:", err);
  }

  render();
  renderDealerOps();
  refreshCardStatuses();

  setupAttendanceLogEvents();
  bindAttendanceLogsRealtime();
}

function wireIndexPageControls() {
  refreshIndexDomRefs();

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

  IX.globalLayoutBtn?.addEventListener("click", () => {
    const tournamentId = getTournamentId();
    if (!tournamentId) {
      alert("대회 정보가 없습니다.");
      return;
    }
    sessionStorage.setItem("tournamentId", tournamentId);
    const eid = String(IX.eventCardId?.value || "").trim();
    const bid = String(IX.eventCardBoxId?.value || "").trim();
    const q = new URLSearchParams();
    q.set("tournamentId", tournamentId);
    if (eid && bid) {
      sessionStorage.setItem("eventId", eid);
      sessionStorage.setItem("boxId", bid);
      q.set("eventId", eid);
      q.set("boxId", bid);
    }
    location.href = `./global-layout.html?${q.toString()}`;
  });

  IX.eventAdminBtn?.addEventListener("click", async () => {
    await loadEvents();
    populateEventSelect();
    renderEventAdminList();
    openModal(IX.eventAdminModal);
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

  IX.dealerOpsMount?.addEventListener("input", (e) => {
    const searchEl = e.target.closest("[data-dealer-search]");
    if (!searchEl) return;

    IX.dealerAdminUi.search = String(searchEl.value || "");
    renderDealerOps();
  });

  IX.dealerOpsMount?.addEventListener("change", (e) => {
    const filterEl = e.target.closest("[data-dealer-filter]");
    if (filterEl) {
      IX.dealerAdminUi.status = String(filterEl.value || "all");
      renderDealerOps();
      return;
    }

    const sortEl = e.target.closest("[data-dealer-sort]");
    if (sortEl) {
      IX.dealerAdminUi.sort = String(sortEl.value || "name");
      renderDealerOps();
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
      const isAdmin = getIsAdmin(user, IX.currentUserProfile);

      if (isAdmin) {
        const adminBtn = e.target.closest("[data-admin-action]");
        if (adminBtn) {
          const action = String(adminBtn.getAttribute("data-admin-action") || "").trim();
          const uid = String(adminBtn.getAttribute("data-admin-uid") || "").trim();

          if (!action || !uid) return;

          if (action === "checked_out") {
            const target = getAdminAttendanceList().find((item) => String(item.uid || "").trim() === uid);
            if (!target) return;

            await forceAdminCheckedOut(target);
            await loadDealerAttendanceOnce();
            renderDealerOps();
            return;
          }
        }

        return;
      }

      const selfBtn = e.target.closest("[data-self-action]");
      if (!selfBtn || !user) return;

      const action = String(selfBtn.getAttribute("data-self-action") || "").trim();
      if (!action) return;

      if (action === "waiting") {
        const ok = await joinSharedWaitingOnCheckIn(user);
        if (!ok) return;

        await updateMyAttendanceStatus("waiting");
        await loadDealerAttendanceOnce();
        renderDealerOps();
        return;
      }

      if (action === "checked_out") {
        const removed = await removeFromSharedWaitingOnCheckOut(user);
        if (removed === false) return;

        await forceSelfCheckedOut(user);
        await loadDealerAttendanceOnce();
        renderDealerOps();
        return;
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
} else {
  wireIndexPageControls();
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
    if (IX.stopMySeatNotificationWatch) {
      IX.stopMySeatNotificationWatch();
      IX.stopMySeatNotificationWatch = null;
    }
    location.replace("./login.html");
    return;
  }

  bindMySeatAssignment(user);

  try {
    refreshIndexDomRefs();

    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    IX.currentUserProfile = userSnap.exists() ? (userSnap.data() || {}) : null;

    if (!IX.currentUserProfile) {
      IX.currentUserProfile = {
        email: user.email || "",
        nickname: user.displayName || "",
        role: isAdminEmail(user.email || "") ? "admin" : "user",
        accessCode: "",
        allowedEvents: {}
      };
      await setDoc(userRef, IX.currentUserProfile, { merge: true });
    }

    const isAdmin = getIsAdmin(auth.currentUser, IX.currentUserProfile);

    if (isAppDebugEnabled()) {
      console.debug("[INDEX AUTH]", {
        uid: user.uid,
        email: user.email || "",
        profile: IX.currentUserProfile,
        isAdmin
      });
    }

    renderDealerOps();

    if (isAdmin) {
      IX.globalLayoutBtn?.classList.remove("hidden");
      IX.eventAdminBtn?.classList.remove("hidden");
      IX.attendanceLogBtn?.classList.remove("hidden");
      IX.seatMapOpenEditorBtn?.classList.remove("hidden");
      if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "1";
    } else {
      IX.globalLayoutBtn?.classList.add("hidden");
      IX.eventAdminBtn?.classList.add("hidden");
      IX.attendanceLogBtn?.classList.add("hidden");
      IX.seatMapOpenEditorBtn?.classList.add("hidden");
      if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "0";
    }

    syncPushOfferButton(IX.enablePushBtn, user.uid);
    void refreshFcmTokenIfGranted(user.uid);
    flushAppBadgeIfVisible();

    await init();
    await initTournamentPeriodWatch();
  } catch (err) {
    console.error("index auth init error:", err);
    alert("인덱스 데이터를 불러오지 못했습니다.");
  }
});

setInterval(() => {
  refreshCardStatuses();
}, 1000);

setInterval(() => {
  if (IX.currentTournament && !isTournamentActive(IX.currentTournament)) {
    routeToHub("대회 기간이 종료되어 허브로 이동합니다.");
  }
}, 60000);

window.addEventListener("beforeunload", () => {
  if (IX.stopTournamentWatch) IX.stopTournamentWatch();
  if (IX.stopMySeatNotificationWatch) IX.stopMySeatNotificationWatch();
  if (IX.stopEventsWatch) IX.stopEventsWatch();
  if (IX.stopLayoutEventsWatch) IX.stopLayoutEventsWatch();
  if (IX.stopDealerAttendanceWatch) IX.stopDealerAttendanceWatch();
  if (IX.stopDealerSeatWatch) IX.stopDealerSeatWatch();
});
