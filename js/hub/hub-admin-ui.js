import { escapeHtml, openModal, closeModal } from "../shared/dom-utils.js";
import {
  hasDirectEventAllowFor,
  isSystemAdminEmail,
  opsAllowedEventsFromProfile,
  sanitizeAllowedEvents
} from "../shared/auth-helpers.js";
import { hasEventAccess, sortUsersForAdminList } from "./hub-helpers.js";
import { hubState } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";

function userOpsAllowedForMeta(user = {}) {
  const merged = opsAllowedEventsFromProfile({
    allowedEvents: user._rawAllowedEvents,
    opsTournamentIds: user._rawOpsTournamentIds
  });
  if (Object.keys(merged).length) return merged;
  return sanitizeAllowedEvents(user.allowedEvents);
}

function userRoleMetaForEvent(user, eventId = "") {
  if (isSystemAdminEmail(user?.email)) {
    return { label: "시스템 admin", ok: true };
  }
  if (hasDirectEventAllowFor(userOpsAllowedForMeta(user), eventId)) {
    return { label: "운영 admin", ok: true };
  }
  return { label: "user", ok: false };
}

function isDirectAllowedForEvent(user, eventId = "") {
  return hasDirectEventAllowFor(userOpsAllowedForMeta(user), eventId);
}

export function getSelectedTournament() {
  const { adminEventSelect } = hubRefs;
  const selectedId = adminEventSelect?.value || "";
  return hubState.tournamentsCache.find((t) => t.id === selectedId) || null;
}

export function getTournamentById(tournamentId = "") {
  const id = String(tournamentId || "").trim();
  if (!id) return null;
  return hubState.tournamentsCache.find((t) => t.id === id) || null;
}

export function setAdminControlsBusy(busy) {
  const {
    saveTournamentBtn,
    deleteTournamentBtn,
    manageAllowBtn,
    manageRevokeBtn,
    manageAssignCodeBtn,
    manageRemoveCodeBtn,
    adminBulkSelectAll,
    adminBulkAssignCodeBtn,
    adminBulkRemoveCodeBtn
  } = hubRefs;

  const controls = [
    saveTournamentBtn,
    deleteTournamentBtn,
    manageAllowBtn,
    manageRevokeBtn,
    manageAssignCodeBtn,
    manageRemoveCodeBtn,
    adminBulkAssignCodeBtn,
    adminBulkRemoveCodeBtn
  ];

  controls.forEach((btn) => {
    if (!btn) return;
    btn.disabled = busy;
    btn.setAttribute("aria-busy", busy ? "true" : "false");
  });

  if (adminBulkSelectAll) {
    adminBulkSelectAll.disabled = busy;
    adminBulkSelectAll.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

export async function runAdminAction(task) {
  if (hubState.adminActionInFlight) return false;
  hubState.adminActionInFlight = true;
  setAdminControlsBusy(true);
  try {
    await task();
    return true;
  } finally {
    hubState.adminActionInFlight = false;
    setAdminControlsBusy(false);
  }
}

export function userStillHasAccessToSelectedEvent(user) {
  const tournament = getSelectedTournament();
  if (!user || !tournament) return false;
  return hasEventAccess(user, tournament, hubState.currentUser);
}

export function populateTournamentSelect() {
  const { adminEventSelect } = hubRefs;
  if (!adminEventSelect) return;

  const previous = adminEventSelect.value;
  adminEventSelect.innerHTML = "";

  hubState.tournamentsCache.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    adminEventSelect.appendChild(opt);
  });

  const still = hubState.tournamentsCache.some((t) => t.id === previous);
  if (still) {
    adminEventSelect.value = previous;
    syncSelectedTournamentForm();
  } else if (hubState.tournamentsCache.length) {
    adminEventSelect.value = hubState.tournamentsCache[0].id;
    syncSelectedTournamentForm();
  } else {
    resetTournamentForm();
  }
}

export function syncSelectedTournamentForm() {
  const {
    adminEventSelect,
    adminTournamentId,
    adminTournamentName,
    adminTournamentStartDate,
    adminTournamentEndDate,
    adminTournamentLogoText,
    adminEventCode
  } = hubRefs;

  const selectedId = adminEventSelect?.value || "";
  const tournament = hubState.tournamentsCache.find((t) => t.id === selectedId);

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

export function resetTournamentForm() {
  const {
    adminTournamentId,
    adminTournamentName,
    adminTournamentStartDate,
    adminTournamentEndDate,
    adminTournamentLogoText,
    adminEventCode
  } = hubRefs;

  adminTournamentId.value = "";
  adminTournamentName.value = "";
  adminTournamentStartDate.value = "";
  adminTournamentEndDate.value = "";
  adminTournamentLogoText.value = "";
  adminEventCode.value = "";
}

export function getFilteredUsers() {
  const { adminSearchInput } = hubRefs;
  const keyword = String(adminSearchInput?.value || "").trim().toLowerCase();
  if (!keyword) return hubState.usersCache;

  return hubState.usersCache.filter((user) => {
    const nickname = String(user.nickname || "").toLowerCase();
    const email = String(user.email || "").toLowerCase();
    return nickname.includes(keyword) || email.includes(keyword);
  });
}

export function getUserByUid(uid) {
  return hubState.usersCache.find((u) => u.uid === uid) || null;
}

export function renderUserManageModal(uid) {
  const { adminEventSelect, manageUserName, manageUserEmail, manageUserMeta, userManageModal } =
    hubRefs;

  const selectedEventId = adminEventSelect?.value || "";
  const selectedTournament = hubState.tournamentsCache.find((t) => t.id === selectedEventId);
  const user = getUserByUid(uid);

  if (!user) return;

  hubState.selectedManageUid = uid;

  const directAllowed = isDirectAllowedForEvent(user, selectedEventId);
  const roleMeta = userRoleMetaForEvent(user, selectedEventId);
  const codeMatched =
    !!user.accessCode &&
    !!selectedTournament?.requiredCode &&
    user.accessCode === selectedTournament.requiredCode;

  manageUserName.textContent = user.nickname || "이름 없음";
  manageUserEmail.textContent = user.email || user.uid;

  manageUserMeta.innerHTML = `
    <span class="meta-pill ${roleMeta.ok ? "ok" : ""}">${escapeHtml(roleMeta.label)}</span>
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

export function closeUserManageModal() {
  const { userManageModal } = hubRefs;
  hubState.selectedManageUid = null;
  closeModal(userManageModal);
}

export function clearAdminBulkSelection() {
  hubState.adminBulkSelectedUids.clear();
  const { adminBulkSelectAll } = hubRefs;
  if (adminBulkSelectAll) {
    adminBulkSelectAll.checked = false;
    adminBulkSelectAll.indeterminate = false;
  }
}

/** 「전체 선택」체크박스: 현재 필터된 목록만 반영 */
export function applyAdminBulkSelectAll(checked) {
  const users = sortUsersForAdminList(getFilteredUsers());
  if (checked) {
    users.forEach((u) => hubState.adminBulkSelectedUids.add(u.uid));
  } else {
    users.forEach((u) => hubState.adminBulkSelectedUids.delete(u.uid));
  }
  renderAdminUserList();
}

export function syncAdminBulkSelectAllCheckbox() {
  const { adminBulkSelectAll } = hubRefs;
  if (!adminBulkSelectAll) return;

  const users = sortUsersForAdminList(getFilteredUsers());
  if (!users.length) {
    adminBulkSelectAll.checked = false;
    adminBulkSelectAll.indeterminate = false;
    return;
  }

  const n = users.filter((u) => hubState.adminBulkSelectedUids.has(u.uid)).length;
  adminBulkSelectAll.checked = n === users.length;
  adminBulkSelectAll.indeterminate = n > 0 && n < users.length;
}

export function renderAdminUserList() {
  const { adminUserList, adminEventSelect } = hubRefs;
  if (!adminUserList) return;

  const selectedEventId = adminEventSelect?.value || "";
  const selectedTournament = hubState.tournamentsCache.find((t) => t.id === selectedEventId);
  const users = sortUsersForAdminList(getFilteredUsers());

  if (!users.length) {
    adminUserList.innerHTML = `<div class="empty-users">표시할 유저가 없습니다.</div>`;
    syncAdminBulkSelectAllCheckbox();
    return;
  }

  adminUserList.innerHTML = users
    .map((user) => {
      const directAllowed = isDirectAllowedForEvent(user, selectedEventId);
      const roleMeta = userRoleMetaForEvent(user, selectedEventId);
      const codeMatched =
        !!user.accessCode &&
        !!selectedTournament?.requiredCode &&
        user.accessCode === selectedTournament.requiredCode;
      const checked = hubState.adminBulkSelectedUids.has(user.uid) ? "checked" : "";

      return `
      <div class="user-row user-row--with-check" data-uid="${escapeHtml(user.uid)}">
        <label class="user-check-wrap" title="일괄 작업에 포함">
          <input type="checkbox" class="admin-user-cb" data-uid="${escapeHtml(user.uid)}" ${checked} />
        </label>
        <div class="user-main">
          <div class="user-name">${escapeHtml(user.nickname || "이름 없음")}</div>
          <div class="user-email">${escapeHtml(user.email || user.uid)}</div>
          <div class="user-meta">
            <span class="meta-pill ${roleMeta.ok ? "ok" : ""}">${escapeHtml(roleMeta.label)}</span>
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
    })
    .join("");

  syncAdminBulkSelectAllCheckbox();
}
