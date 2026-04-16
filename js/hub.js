import { auth, db } from "./firebase.js";

import {
  onAuthStateChanged,
  signOut
  
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  doc,
  getDoc,
  getDocs,
  updateDoc,
  setDoc,
  deleteDoc,
  collection,
  deleteField,
  onSnapshot,
  query,
  where,
  writeBatch,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { isAdminEmail } from "./app_config.js";

const $ = (id) => document.getElementById(id);

const eventListEl = $("eventList");
const logoutBtn = $("logoutBtn");
const profileBtn = $("profileBtn");
const adminBtn = $("adminBtn");

const profileModal = $("profileModal");
const closeProfileBtn = $("closeProfileBtn");
const saveProfileBtn = $("saveProfileBtn");

const profileEmail = $("profileEmail");
const profileNickname = $("profileNickname");
const profileAccessCode = $("profileAccessCode");

const adminModal = $("adminModal");
const closeAdminBtn = $("closeAdminBtn");

const adminEventSelect = $("adminEventSelect");
const adminSearchInput = $("adminSearchInput");

const adminTournamentId = $("adminTournamentId");
const adminTournamentName = $("adminTournamentName");
const adminTournamentStartDate = $("adminTournamentStartDate");
const adminTournamentEndDate = $("adminTournamentEndDate");
const adminTournamentLogoText = $("adminTournamentLogoText");
const adminEventCode = $("adminEventCode");

const newTournamentBtn = $("newTournamentBtn");
const saveTournamentBtn = $("saveTournamentBtn");
const deleteTournamentBtn = $("deleteTournamentBtn");

const adminUserList = $("adminUserList");

const userManageModal = $("userManageModal");
const closeUserManageBtn = $("closeUserManageBtn");
const closeUserManageFooterBtn = $("closeUserManageFooterBtn");

const manageUserName = $("manageUserName");
const manageUserEmail = $("manageUserEmail");
const manageUserMeta = $("manageUserMeta");

const manageAllowBtn = $("manageAllowBtn");
const manageRevokeBtn = $("manageRevokeBtn");
const manageAssignCodeBtn = $("manageAssignCodeBtn");
const manageRemoveCodeBtn = $("manageRemoveCodeBtn");
const manageViewCodeBtn = $("manageViewCodeBtn");

let currentUser = null;
let currentUserProfile = null;
let tournamentsCache = [];
let usersCache = [];
let selectedManageUid = null;
let stopTournamentsWatch = null;
let stopUsersWatch = null;
let adminActionInFlight = false;

const fallbackTournaments = [
  {
    id: "ept-paris-2026",
    name: "EPT Paris 2026",
    startDate: "26.02.18",
    endDate: "26.03.01",
    logoText: "EPT",
    requiredCode: "EPT2026A"
  }
];


/* ===============================
   HELPERS
=============================== */
function openModal(el) {
  el?.classList.add("show");
}

function closeModal(el) {
  el?.classList.remove("show");
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const LAYOUT_EVENTS_REF = collection(db, "layout_events");
const GLOBAL_WAITING_REF = doc(db, "layout_shared", "global_waiting");

async function removeUserFromEventWaiting(user, selectedTournamentId = "") {
  if (!user) return 0;

  const targetUid = String(user.uid || "").trim();
  const targetName = String(user.nickname || "").trim();
  const tournamentId = String(selectedTournamentId || "").trim();

  if (!targetUid && !targetName) return 0;

  try {
    let removedCount = 0;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(GLOBAL_WAITING_REF);
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const waiting = Array.isArray(data.waiting) ? data.waiting : [];
      if (!waiting.length) return;

      const nextWaiting = waiting.filter((item) => {
        if (!item || typeof item !== "object") return false;

        const itemUid = String(item.uid || "").trim();
        const itemName = String(item.name || "").trim();
        const itemTournamentId = String(item.tournamentId || "").trim();

        if (tournamentId && itemTournamentId && itemTournamentId !== tournamentId) {
          return true;
        }

        if (targetUid && itemUid && itemUid === targetUid) {
          removedCount += 1;
          return false;
        }

        if (!targetUid && targetName && itemName === targetName) {
          removedCount += 1;
          return false;
        }

        return true;
      });

      if (removedCount > 0) {
        tx.set(
          GLOBAL_WAITING_REF,
          {
            ...data,
            version: 2,
            waiting: nextWaiting,
            updatedAt: Date.now()
          },
          { merge: true }
        );
      }
    });

    return removedCount;
  } catch (err) {
    console.error("removeUserFromEventWaiting error:", err);
    return 0;
  }
}

async function removeUserFromAllSeats(user, selectedTournamentId = "") {
  if (!user) return 0;

  const targetUid = String(user.uid || "").trim();
  const targetName = String(user.nickname || "").trim();
  const tournamentId = String(selectedTournamentId || "").trim();

  if (!targetUid && !targetName) return 0;

  let removedCount = 0;

  const snap = await getDocs(LAYOUT_EVENTS_REF);
  if (snap.empty) return 0;

  const batch = writeBatch(db);

  snap.forEach((d) => {
    const data = d.data() || {};

    if (tournamentId) {
      const itemTournamentId = String(data.tournamentId || "").trim();
      if (itemTournamentId && itemTournamentId !== tournamentId) {
        return;
      }
    }

    const seats = Array.isArray(data.seats) ? data.seats : [];
    let changed = false;

    const nextSeats = seats.map((seat) => {
      if (!seat || typeof seat !== "object") return seat;

      const person = String(seat.person || "").trim();
      const personUid = String(seat.personUid || "").trim();

      const uidMatched = targetUid && personUid && personUid === targetUid;
      const nameMatched = !targetUid && targetName && person === targetName;

      if (!uidMatched && !nameMatched) return seat;

      removedCount += 1;
      changed = true;

      return {
        ...seat,
        person: "비어있음",
        personUid: "",
        personEmail: "",
        seatedAt: null
      };
    });

    if (changed) {
      batch.set(
        d.ref,
        {
          seats: nextSeats,
          updatedAt: Date.now()
        },
        { merge: true }
      );
    }
  });

  if (removedCount > 0) {
    await batch.commit();
  }

  return removedCount;
}

async function cleanupUserFromLayoutState(user, tournamentId = "") {
  const waitingRemoved = await removeUserFromEventWaiting(user, tournamentId);
  const seatRemoved = await removeUserFromAllSeats(user, tournamentId);

  return {
    waitingRemoved,
    seatRemoved
  };
}

function hasEventAccess(userProfile, tournament, user = currentUser) {
  if (!userProfile) return false;
  if (userProfile.role === "admin" || isAdminEmail(user?.email || "")) return true;

  const allowedEvents = userProfile.allowedEvents || {};
  if (allowedEvents[tournament.id] === true) return true;

  const userCode = String(userProfile.accessCode || "").trim();
  const requiredCode = String(tournament.requiredCode || "").trim();

  if (userCode && requiredCode && userCode === requiredCode) return true;

  return false;
}

function getIsAdminUser(user = currentUser, profile = currentUserProfile) {
  return (
    profile?.role === "admin" ||
    isAdminEmail(user?.email || "")
  );
}

function getSelectedTournament() {
  const selectedId = adminEventSelect?.value || "";
  return tournamentsCache.find((t) => t.id === selectedId) || null;
}

function getTournamentById(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  return tournamentsCache.find((t) => t.id === id) || null;
}

function isValidDocId(id = "") {
  const value = String(id || "").trim();
  return !!value && !value.includes("/");
}

function setAdminControlsBusy(busy) {
  const controls = [
    saveTournamentBtn,
    deleteTournamentBtn,
    manageAllowBtn,
    manageRevokeBtn,
    manageAssignCodeBtn,
    manageRemoveCodeBtn
  ];

  controls.forEach((btn) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.setAttribute("aria-busy", busy ? "true" : "false");
  });
}

async function runAdminAction(task) {
  if (adminActionInFlight) return false;
  adminActionInFlight = true;
  setAdminControlsBusy(true);
  try {
    await task();
    return true;
  } finally {
    adminActionInFlight = false;
    setAdminControlsBusy(false);
  }
}

function userStillHasAccessToSelectedEvent(user) {
  const tournament = getSelectedTournament();
  if (!user || !tournament) return false;
  return hasEventAccess(user, tournament, currentUser);
}

function normalizeTournamentDoc(d) {
  const data = d.data() || {};
  return {
    id: d.id,
    name: data.name || d.id,
    startDate: data.startDate || "",
    endDate: data.endDate || "",
    logoText: data.logoText || "HAN",
    requiredCode: data.requiredCode || ""
  };
}

function normalizeUserDoc(d) {
  const data = d.data() || {};
  return {
    uid: d.id,
    nickname: data.nickname || "",
    email: data.email || "",
    role: data.role || "user",
    accessCode: data.accessCode || "",
    allowedEvents: data.allowedEvents || {}
  };
}

function sortTournaments(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function routeToTournament(tournamentId) {
  if (!tournamentId) return;
  sessionStorage.setItem("tournamentId", tournamentId);
  location.href = `./index.html?tournamentId=${encodeURIComponent(tournamentId)}`;
}

/* ===============================
   TOURNAMENT RENDER
=============================== */
function renderTournaments(tournaments, userProfile, user = currentUser) {
  if (!eventListEl) return;

  eventListEl.innerHTML = "";

  tournaments.forEach((tournament) => {
    const enabled = hasEventAccess(userProfile, tournament, user);

    const card = document.createElement("article");
    card.className = `event-card ${enabled ? "is-enabled" : "is-locked"}`;
    card.dataset.tournamentId = tournament.id;

    card.innerHTML = `
      <div class="event-left">${escapeHtml(tournament.logoText || "HAN")}</div>

      <div class="event-center">
        <h2 class="event-title">${escapeHtml(tournament.name)}</h2>
        <div class="event-date">
          ${escapeHtml(tournament.startDate)} ~ ${escapeHtml(tournament.endDate)}
        </div>
        <div class="event-access">
          ${enabled ? "접속 가능" : "허용된 계정만 입장 가능"}
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

/* ===============================
   LOADERS
=============================== */
async function loadTournaments() {
  try {
    const snap = await getDocs(collection(db, "tournaments"));

    if (snap.empty) {
      tournamentsCache = sortTournaments(fallbackTournaments);
      return tournamentsCache;
    }

    tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
    return tournamentsCache;
  } catch (err) {
    console.error("loadTournaments error:", err);
    tournamentsCache = sortTournaments(fallbackTournaments);
    return tournamentsCache;
  }
}

async function loadAllUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    usersCache = snap.docs.map(normalizeUserDoc);
    return usersCache;
  } catch (err) {
    console.error("loadAllUsers error:", err);
    usersCache = [];
    return usersCache;
  }
}

async function loadUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return snap.data();
}

/* ===============================
   REALTIME WATCHERS
=============================== */
function bindTournamentsRealtime() {
  if (stopTournamentsWatch) {
    stopTournamentsWatch();
    stopTournamentsWatch = null;
  }

  stopTournamentsWatch = onSnapshot(
    collection(db, "tournaments"),
    (snap) => {
      if (snap.empty) {
        tournamentsCache = sortTournaments(fallbackTournaments);
      } else {
        tournamentsCache = sortTournaments(snap.docs.map(normalizeTournamentDoc));
      }

      renderTournaments(tournamentsCache, currentUserProfile);

      if (getIsAdminUser() && adminModal?.classList.contains("show")) {
        const selectedId = adminTournamentId?.value?.trim() || adminEventSelect?.value || "";
        populateTournamentSelect();

        if (selectedId && tournamentsCache.some((t) => t.id === selectedId)) {
          adminEventSelect.value = selectedId;
          syncSelectedTournamentForm();
        }

        renderAdminUserList();

        if (selectedManageUid) {
          renderUserManageModal(selectedManageUid);
        }
      }
    },
    (err) => {
      console.error("bindTournamentsRealtime error:", err);
    }
  );
}

function bindUsersRealtime() {
  if (stopUsersWatch) {
    stopUsersWatch();
    stopUsersWatch = null;
  }

  stopUsersWatch = onSnapshot(
    collection(db, "users"),
    (snap) => {
      usersCache = snap.docs.map(normalizeUserDoc);

      const me = usersCache.find((u) => u.uid === currentUser?.uid);
      if (me) {
        currentUserProfile = {
          ...currentUserProfile,
          ...me
        };
      }

      console.log("[HUB USERS REALTIME]", {
  uid: currentUser?.uid || "",
  email: currentUser?.email || "",
  profile: currentUserProfile,
  isAdmin: currentUserProfile?.role === "admin"
});

      renderTournaments(tournamentsCache, currentUserProfile);

      const isAdmin = getIsAdminUser();

if (isAdmin) {
  adminBtn?.classList.remove("hidden");

        if (adminModal?.classList.contains("show")) {
          renderAdminUserList();

          if (selectedManageUid) {
            renderUserManageModal(selectedManageUid);
          }
        }
      } else {
        adminBtn?.classList.add("hidden");
      }
    },
    (err) => {
      console.error("bindUsersRealtime error:", err);
    }
  );
}

/* ===============================
   ADMIN TOURNAMENT FORM
=============================== */
function populateTournamentSelect() {
  if (!adminEventSelect) return;

  adminEventSelect.innerHTML = tournamentsCache
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`)
    .join("");

  if (tournamentsCache.length) {
    adminEventSelect.value = tournamentsCache[0].id;
    syncSelectedTournamentForm();
  } else {
    resetTournamentForm();
  }
}

function syncSelectedTournamentForm() {
  const selectedId = adminEventSelect?.value || "";
  const tournament = tournamentsCache.find((t) => t.id === selectedId);

  if (!tournament) {
    resetTournamentForm();
    return;
  }

  adminTournamentId.value = tournament.id || "";
  adminTournamentName.value = tournament.name || "";
  adminTournamentStartDate.value = tournament.startDate || "";
  adminTournamentEndDate.value = tournament.endDate || "";
  adminTournamentLogoText.value = tournament.logoText || "";
  adminEventCode.value = tournament.requiredCode || "";
}

function resetTournamentForm() {
  adminTournamentId.value = "";
  adminTournamentName.value = "";
  adminTournamentStartDate.value = "";
  adminTournamentEndDate.value = "";
  adminTournamentLogoText.value = "";
  adminEventCode.value = "";
}

/* ===============================
   ADMIN USER LIST
=============================== */
/** 정렬용 표시명: 닉네임 우선, 없으면 이메일 */
function getUserDisplayNameForSort(user) {
  const nick = String(user?.nickname || "").trim();
  if (nick) return nick;
  return String(user?.email || user?.uid || "").trim();
}

/**
 * 가입 유저 목록: 한글(가나다·ㄱ~ㅎ 계열) 먼저, 그다음 영문 A~Z, 그 외.
 */
function getNameSortGroup(str) {
  const s = String(str || "").trim();
  if (!s) return 2;
  const cp = s.codePointAt(0);
  if (cp >= 0xac00 && cp <= 0xd7a3) return 0;
  if (cp >= 0x1100 && cp <= 0x11ff) return 0;
  if (cp >= 0x3130 && cp <= 0x318f) return 0;
  if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return 1;
  return 2;
}

function compareUsersForAdminList(a, b) {
  const na = getUserDisplayNameForSort(a);
  const nb = getUserDisplayNameForSort(b);
  const ga = getNameSortGroup(na);
  const gb = getNameSortGroup(nb);
  if (ga !== gb) return ga - gb;
  if (ga === 0) return na.localeCompare(nb, "ko", { numeric: true });
  if (ga === 1) return na.localeCompare(nb, "en", { sensitivity: "base", numeric: true });
  return na.localeCompare(nb, "ko", { numeric: true });
}

function sortUsersForAdminList(users) {
  return [...users].sort(compareUsersForAdminList);
}

function getFilteredUsers() {
  const keyword = String(adminSearchInput?.value || "").trim().toLowerCase();
  if (!keyword) return usersCache;

  return usersCache.filter((user) => {
    const nickname = String(user.nickname || "").toLowerCase();
    const email = String(user.email || "").toLowerCase();
    return nickname.includes(keyword) || email.includes(keyword);
  });
}

function getUserByUid(uid) {
  return usersCache.find((u) => u.uid === uid) || null;
}

function renderUserManageModal(uid) {
  const selectedEventId = adminEventSelect?.value || "";
  const selectedTournament = tournamentsCache.find((t) => t.id === selectedEventId);
  const user = getUserByUid(uid);

  if (!user) return;

  selectedManageUid = uid;

  const directAllowed = user.allowedEvents?.[selectedEventId] === true;
  const codeMatched =
    !!user.accessCode &&
    !!selectedTournament?.requiredCode &&
    user.accessCode === selectedTournament.requiredCode;

  manageUserName.textContent = user.nickname || "이름 없음";
  manageUserEmail.textContent = user.email || user.uid;

  manageUserMeta.innerHTML = `
    <span class="meta-pill">${escapeHtml(user.role)}</span>
    <span class="meta-pill">${escapeHtml(user.accessCode || "코드 없음")}</span>
    <span class="meta-pill ${directAllowed ? "ok" : "lock"}">
      ${directAllowed ? "직접 허용됨" : "직접 허용 없음"}
    </span>
    <span class="meta-pill ${codeMatched ? "ok" : "lock"}">
      ${codeMatched ? "코드 일치" : "코드 불일치"}
    </span>
  `;

  openModal(userManageModal);
}

function closeUserManageModal() {
  selectedManageUid = null;
  closeModal(userManageModal);
}

function renderAdminUserList() {
  if (!adminUserList) return;

  const selectedEventId = adminEventSelect?.value || "";
  const selectedTournament = tournamentsCache.find((t) => t.id === selectedEventId);
  const users = sortUsersForAdminList(getFilteredUsers());

  if (!users.length) {
    adminUserList.innerHTML = `<div class="empty-users">표시할 유저가 없습니다.</div>`;
    return;
  }

  adminUserList.innerHTML = users.map((user) => {
    const directAllowed = user.allowedEvents?.[selectedEventId] === true;
    const codeMatched =
      !!user.accessCode &&
      !!selectedTournament?.requiredCode &&
      user.accessCode === selectedTournament.requiredCode;

    return `
      <div class="user-row" data-uid="${escapeHtml(user.uid)}">
        <div class="user-main">
          <div class="user-name">${escapeHtml(user.nickname || "이름 없음")}</div>
          <div class="user-email">${escapeHtml(user.email || user.uid)}</div>
          <div class="user-meta">
            <span class="meta-pill">${escapeHtml(user.role)}</span>
            <span class="meta-pill">${escapeHtml(user.accessCode || "코드 없음")}</span>
            <span class="meta-pill ${directAllowed ? "ok" : "lock"}">
              ${directAllowed ? "직접 허용됨" : "직접 허용 없음"}
            </span>
            <span class="meta-pill ${codeMatched ? "ok" : "lock"}">
              ${codeMatched ? "코드 일치" : "코드 불일치"}
            </span>
          </div>
        </div>

        <button
          class="user-manage-trigger"
          type="button"
          data-action="openManage"
          data-uid="${escapeHtml(user.uid)}"
        >
          관리
        </button>
      </div>
    `;
  }).join("");
}

/* ===============================
   PROFILE
=============================== */
async function saveNickname() {
  if (!currentUser) return;

  const nickname = profileNickname.value.trim();

  if (nickname.length < 2 || nickname.length > 7) {
    alert("닉네임은 2~7자로 입력해주세요.");
    return;
  }

  try {
    await setDoc(
      doc(db, "users", currentUser.uid),
      { nickname },
      { merge: true }
    );

    if (currentUserProfile) {
      currentUserProfile.nickname = nickname;
    }

    const cacheUser = usersCache.find((u) => u.uid === currentUser.uid);
    if (cacheUser) {
      cacheUser.nickname = nickname;
    }

    alert("닉네임이 저장되었습니다.");
    closeModal(profileModal);
    renderAdminUserList();
    renderTournaments(tournamentsCache, currentUserProfile);
  } catch (err) {
    console.error(err);
    alert("닉네임 저장에 실패했습니다.");
  }
}

/* ===============================
   TOURNAMENT CRUD
=============================== */
async function saveTournament() {
  if (!getIsAdminUser()) return;

  const id = adminTournamentId.value.trim();
  const name = adminTournamentName.value.trim();
  const startDate = adminTournamentStartDate.value.trim();
  const endDate = adminTournamentEndDate.value.trim();
  const logoText = adminTournamentLogoText.value.trim();
  const requiredCode = adminEventCode.value.trim();

  if (!id || !name) {
    alert("대회 ID와 대회명을 입력해주세요.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("대회 ID에는 '/' 문자를 사용할 수 없습니다.");
    return;
  }

  try {
    await setDoc(
      doc(db, "tournaments", id),
      { name, startDate, endDate, logoText, requiredCode },
      { merge: true }
    );

    alert("대회가 저장되었습니다.");
  } catch (err) {
    console.error(err);
    alert("대회 저장에 실패했습니다.");
  }
}

async function deleteTournamentCurrent() {
  if (!getIsAdminUser()) return;

  const id = adminTournamentId.value.trim();
  if (!id) {
    alert("삭제할 대회가 없습니다.");
    return;
  }

  if (!isValidDocId(id)) {
    alert("유효하지 않은 대회 ID입니다.");
    return;
  }

  const ok = confirm(`"${id}" 대회를 삭제할까요?`);
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "tournaments", id));
    alert("대회가 삭제되었습니다.");
  } catch (err) {
    console.error(err);
    alert("대회 삭제에 실패했습니다.");
  }
}

/* ===============================
   ACCESS / CODE ACTIONS
=============================== */
async function grantEventDirectly(uid, eventId) {
  if (!getIsAdminUser()) return;
  if (!uid || !eventId) return;
  if (!getTournamentById(eventId)) {
    alert("유효한 대회를 먼저 선택해주세요.");
    return;
  }

  try {
    await setDoc(
      doc(db, "users", uid),
      {
        allowedEvents: {
          [eventId]: true
        }
      },
      { merge: true }
    );

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.allowedEvents = {
        ...(user.allowedEvents || {}),
        [eventId]: true
      };
    }

    renderAdminUserList();
    alert("직접 허용이 저장되었습니다.");
  } catch (err) {
    console.error(err);
    alert("직접 허용 저장에 실패했습니다.");
  }
}

async function revokeEventDirectly(uid, eventId) {
  if (!getIsAdminUser()) return;
  if (!uid || !eventId) return;
  const tournament = getTournamentById(eventId);
  if (!tournament) {
    alert("유효한 대회를 먼저 선택해주세요.");
    return;
  }

  try {
    await updateDoc(doc(db, "users", uid), {
      [`allowedEvents.${eventId}`]: deleteField()
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user?.allowedEvents) {
      delete user.allowedEvents[eventId];
    }

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };

    const requiredCode = String(tournament.requiredCode || "").trim();
    const userCode = String(user?.accessCode || "").trim();
    const stillAllowed =
      user?.role === "admin" ||
      user?.allowedEvents?.[eventId] === true ||
      (userCode && requiredCode && userCode === requiredCode);

if (user && !stillAllowed) {
  cleaned = await cleanupUserFromLayoutState(user, eventId);
}

    renderAdminUserList();

    if (cleaned.waitingRemoved > 0 || cleaned.seatRemoved > 0) {
      alert(
        `직접 허용이 해제되었고, 대기 ${cleaned.waitingRemoved}건 / 좌석 ${cleaned.seatRemoved}건 정리되었습니다.`
      );
    } else {
      alert("직접 허용이 해제되었습니다.");
    }
  } catch (err) {
    console.error(err);
    alert("허용 해제에 실패했습니다.");
  }
}

async function assignEventCodeToUser(uid, eventId) {
  if (!getIsAdminUser()) return;
  if (!uid || !eventId) return;

  try {
    const tournament = getTournamentById(eventId);
    if (!tournament) {
      alert("유효한 대회를 먼저 선택해주세요.");
      return;
    }
    const requiredCode = String(tournament?.requiredCode || "").trim();

    if (!requiredCode) {
      alert("선택한 대회에 설정된 코드가 없습니다.");
      return;
    }

    await updateDoc(doc(db, "users", uid), {
      accessCode: requiredCode
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = requiredCode;
    }

    renderAdminUserList();
    alert(`유저 코드가 부여되었습니다: ${requiredCode}`);
  } catch (err) {
    console.error(err);
    alert("유저 코드 부여에 실패했습니다.");
  }
}

async function removeUserCode(uid) {
  if (!getIsAdminUser()) return;
  if (!uid) return;

  try {
    await updateDoc(doc(db, "users", uid), {
      accessCode: ""
    });

    const user = usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = "";
    }

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };
    const selectedEventId = String(adminEventSelect?.value || "").trim();

    if (selectedEventId && user && !userStillHasAccessToSelectedEvent(user)) {
      cleaned = await cleanupUserFromLayoutState(user, selectedEventId);
    }

    renderAdminUserList();

    if (cleaned.waitingRemoved > 0 || cleaned.seatRemoved > 0) {
      alert(
        `유저 코드가 제거되었고, 대기 ${cleaned.waitingRemoved}건 / 좌석 ${cleaned.seatRemoved}건 정리되었습니다.`
      );
    } else {
      alert("유저 코드가 제거되었습니다.");
    }
  } catch (err) {
    console.error(err);
    alert("유저 코드 제거에 실패했습니다.");
  }
}

function showUserCode(uid) {
  const user = usersCache.find((u) => u.uid === uid);
  if (!user) return;

  alert(`${user.nickname || "이름 없음"}\n접근 코드: ${user.accessCode || "없음"}`);
}

/* ===============================
   EVENTS
=============================== */
logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    location.href = "./login.html";
  } catch (err) {
    console.error(err);
    alert("로그아웃에 실패했습니다.");
  }
});

profileBtn?.addEventListener("click", () => {
  if (!currentUser || !currentUserProfile) return;

  profileEmail.value = currentUser.email || "";
  profileNickname.value = currentUserProfile.nickname || "";
  profileAccessCode.value = currentUserProfile.accessCode || "";
  openModal(profileModal);
});

adminBtn?.addEventListener("click", async () => {
  const isAdmin = getIsAdminUser();

  if (!isAdmin) return;

  if (!tournamentsCache.length) {
    await loadTournaments();
  }
  if (!usersCache.length) {
    await loadAllUsers();
  }

  populateTournamentSelect();
  renderAdminUserList();
  openModal(adminModal);
});

closeProfileBtn?.addEventListener("click", () => closeModal(profileModal));
saveProfileBtn?.addEventListener("click", saveNickname);

closeAdminBtn?.addEventListener("click", () => closeModal(adminModal));

newTournamentBtn?.addEventListener("click", () => {
  resetTournamentForm();
  adminTournamentId.focus();
});

saveTournamentBtn?.addEventListener("click", () => {
  void runAdminAction(saveTournament);
});
deleteTournamentBtn?.addEventListener("click", () => {
  void runAdminAction(deleteTournamentCurrent);
});

adminEventSelect?.addEventListener("change", () => {
  syncSelectedTournamentForm();
  renderAdminUserList();

  if (selectedManageUid) {
    renderUserManageModal(selectedManageUid);
  }
});

adminSearchInput?.addEventListener("input", renderAdminUserList);

adminUserList?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const uid = btn.dataset.uid;

  if (action === "openManage" && uid) {
    renderUserManageModal(uid);
  }
});

profileModal?.addEventListener("click", (e) => {
  if (e.target === profileModal) closeModal(profileModal);
});

adminModal?.addEventListener("click", (e) => {
  if (e.target === adminModal) closeModal(adminModal);
});

closeUserManageBtn?.addEventListener("click", closeUserManageModal);
closeUserManageFooterBtn?.addEventListener("click", closeUserManageModal);

manageAllowBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = adminEventSelect?.value || "";
    if (!selectedManageUid || !eventId) return;
    await grantEventDirectly(selectedManageUid, eventId);
    renderUserManageModal(selectedManageUid);
  });
});

manageRevokeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = adminEventSelect?.value || "";
    if (!selectedManageUid || !eventId) return;
    await revokeEventDirectly(selectedManageUid, eventId);
    renderUserManageModal(selectedManageUid);
  });
});

manageAssignCodeBtn?.addEventListener("click", async () => {
  await runAdminAction(async () => {
    const eventId = adminEventSelect?.value || "";
    if (!selectedManageUid || !eventId) return;
    await assignEventCodeToUser(selectedManageUid, eventId);
    renderUserManageModal(selectedManageUid);
  });
});

manageRemoveCodeBtn?.addEventListener("click", async () => {
  if (!selectedManageUid) return;

  const ok = confirm("이 유저의 코드를 제거할까요?");
  if (!ok) return;

  await runAdminAction(async () => {
    await removeUserCode(selectedManageUid);
    renderUserManageModal(selectedManageUid);
  });
});

manageViewCodeBtn?.addEventListener("click", () => {
  if (!selectedManageUid) return;
  showUserCode(selectedManageUid);
});

userManageModal?.addEventListener("click", (e) => {
  if (e.target === userManageModal) closeUserManageModal();
});

/* ===============================
   AUTH INIT
=============================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("./login.html");
    return;
  }

  currentUser = user;

  try {
    currentUserProfile = await loadUserProfile(user.uid);
    if (!currentUserProfile) {
      const fallbackProfile = {
        email: user.email || "",
        nickname: user.displayName || "",
        role: isAdminEmail(user.email || "") ? "admin" : "user",
        accessCode: "",
        allowedEvents: {}
      };

      await setDoc(doc(db, "users", user.uid), fallbackProfile, { merge: true });
      currentUserProfile = fallbackProfile;
    }
    tournamentsCache = await loadTournaments();

    console.log("[HUB AUTH]", {
  uid: user.uid,
  email: user.email || "",
  profile: currentUserProfile,
  isAdmin: currentUserProfile?.role === "admin"
});

    const isAdmin = getIsAdminUser(user, currentUserProfile);

if (isAdmin) {
  usersCache = await loadAllUsers();
  adminBtn?.classList.remove("hidden");
  bindUsersRealtime();
} else {
  adminBtn?.classList.add("hidden");
}

    renderTournaments(tournamentsCache, currentUserProfile);
    bindTournamentsRealtime();
  } catch (err) {
    console.error(err);
    alert("허브 데이터를 불러오지 못했습니다.");
  }
});

window.addEventListener("beforeunload", () => {
  if (stopTournamentsWatch) stopTournamentsWatch();
  if (stopUsersWatch) stopUsersWatch();
});