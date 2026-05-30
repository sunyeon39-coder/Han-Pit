import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { pickUnusedLayoutAccentColor } from "../shared/layout-operator-colors.js";
import { db } from "../firebase.js";
import { isAdminEmail } from "../app_config.js";
import {
  hasAnyDirectEventAllow,
  normalizeUserProfile,
  resolveDirectOpsRole,
  sanitizeAllowedEvents
} from "../shared/auth-helpers.js";
import {
  buildOpsProfilePatch,
  syncLoginCacheForOpsProfile
} from "../shared/tournament-ops-access.js";
import { clearOpsSessionSnapshot } from "../shared/login-profile-cache.js";
import { getIsAdminUser, isValidDocId } from "./hub-helpers.js";
import { cleanupUserFromLayoutState } from "./layout-cleanup.js";
import { hubState } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { scheduleHubTournamentsRender } from "./hub-realtime-ui.js";
import {
  getTournamentById,
  populateTournamentSelect,
  renderAdminUserList,
  syncAdminBulkSelectAllCheckbox,
  userStillHasAccessToSelectedEvent
} from "./hub-admin-ui.js";
import { renderTournaments } from "./hub-tournament-list.js";

/** allowedEvents=true 인 대회만 opsTournamentIds 에 반영 (해제 후 stale id 가 admin 으로 부활하는 것 방지) */
function buildOpsTournamentIds(nextAllowed = {}) {
  return Object.keys(sanitizeAllowedEvents(nextAllowed));
}

async function collectTargetUidsForEmail(uid, email = "") {
  const targetUids = new Set([uid]);
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) return targetUids;

  for (const u of hubState.usersCache) {
    if (String(u.email || "").trim().toLowerCase() === mail) targetUids.add(u.uid);
  }

  for (const variant of [...new Set([mail, String(email || "").trim()].filter(Boolean))]) {
    try {
      const snap = await getDocs(
        query(collection(db, "users"), where("email", "==", variant), limit(12))
      );
      for (const d of snap.docs) targetUids.add(d.id);
    } catch (err) {
      console.warn("[collectTargetUidsForEmail] query failed:", variant, err);
    }
  }

  return targetUids;
}

export async function saveTournament() {
  const {
    adminTournamentId,
    adminTournamentName,
    adminTournamentStartDate,
    adminTournamentEndDate,
    adminTournamentLogoText,
    adminEventCode
  } = hubRefs;

  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;

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

export async function deleteTournamentCurrent() {
  const { adminTournamentId } = hubRefs;

  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;

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

    hubState.tournamentsCache = hubState.tournamentsCache.filter((t) => t.id !== id);
    renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);

    if (
      getIsAdminUser(hubState.currentUser, hubState.currentUserProfile) &&
      hubRefs.adminModal?.classList.contains("show")
    ) {
      populateTournamentSelect();
      renderAdminUserList();
    }

    alert("대회가 삭제되었습니다.");
  } catch (err) {
    console.error(err);
    alert("대회 삭제에 실패했습니다.");
  }
}

export async function grantEventDirectly(uid, eventId) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
  if (!uid || !eventId) return;
  if (!getTournamentById(eventId)) {
    alert("유효한 대회를 먼저 선택해주세요.");
    return;
  }

  try {
    const cacheUser = hubState.usersCache.find((u) => u.uid === uid);
    const email = String(cacheUser?.email || "").trim();
    const targetUids = await collectTargetUidsForEmail(uid, email);

    const layoutAccentColor =
      String(cacheUser?.layoutAccentColor || "").trim() ||
      pickUnusedLayoutAccentColor(hubState.usersCache, uid);

    for (const targetUid of targetUids) {
      const userRef = doc(db, "users", targetUid);
      const userSnap = await getDoc(userRef);
      const prev = userSnap.exists() ? userSnap.data() || {} : {};
      const mail = String(prev.email || email || "").trim();
      const accent =
        String(prev.layoutAccentColor || "").trim() || layoutAccentColor;

      const nextAllowed = sanitizeAllowedEvents({
        ...(prev.allowedEvents || {}),
        [eventId]: true
      });
      const opsTournamentIds = buildOpsTournamentIds(nextAllowed);
      const role = "admin";

      await updateDoc(userRef, {
        email: mail || email || prev.email || "",
        role,
        layoutAccentColor: accent,
        allowedEvents: nextAllowed,
        opsTournamentIds
      });

      const user = hubState.usersCache.find((u) => u.uid === targetUid);
      if (user) {
        user.role = role;
        user.layoutAccentColor = accent;
        user.allowedEvents = nextAllowed;
        user._rawAllowedEvents = { ...nextAllowed };
      }
    }

    if (hubState.currentUser?.uid && targetUids.has(hubState.currentUser.uid)) {
      const selfAllowed = sanitizeAllowedEvents({
        ...(hubState.currentUserProfile?.allowedEvents || {}),
        [eventId]: true
      });
      hubState.currentUserProfile = buildOpsProfilePatch(
        {
          ...(hubState.currentUserProfile || {}),
          layoutAccentColor:
            hubState.currentUserProfile?.layoutAccentColor || layoutAccentColor
        },
        hubState.currentUser?.email || "",
        selfAllowed
      );
      syncLoginCacheForOpsProfile(hubState.currentUser.uid, hubState.currentUserProfile);
      renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);
    }

    renderAdminUserList();
    const extra =
      targetUids.size > 1
        ? `\n(같은 이메일 계정 ${targetUids.size}건 모두 반영)`
        : "";
    alert(
      `직접 허용되었습니다. 해당 유저는 admin과 동일하게 배치·통합배치도·대회 관리를 할 수 있습니다.${extra}`
    );
  } catch (err) {
    console.error(err);
    alert("직접 허용 저장에 실패했습니다.");
  }
}

export async function revokeEventDirectly(uid, eventId) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
  if (!uid || !eventId) return;
  const tournament = getTournamentById(eventId);
  if (!tournament) {
    alert("유효한 대회를 먼저 선택해주세요.");
    return;
  }

  try {
    const seedUser = hubState.usersCache.find((u) => u.uid === uid);
    const email = String(seedUser?.email || "").trim();
    const targetUids = await collectTargetUidsForEmail(uid, email);

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };

    for (const targetUid of targetUids) {
      const user = hubState.usersCache.find((u) => u.uid === targetUid);
      const prevAllowed = sanitizeAllowedEvents(
        user?._rawAllowedEvents ?? user?.allowedEvents ?? {}
      );
      const nextAllowed = { ...prevAllowed };
      delete nextAllowed[eventId];

      const updates = {
        allowedEvents: nextAllowed,
        opsTournamentIds: buildOpsTournamentIds(nextAllowed),
        role: resolveDirectOpsRole(email, nextAllowed)
      };

      await updateDoc(doc(db, "users", targetUid), updates);

      if (user) {
        user.allowedEvents = nextAllowed;
        user._rawAllowedEvents = { ...nextAllowed };
        user._rawOpsTournamentIds = updates.opsTournamentIds;
        user.role = updates.role;
        user._rawRole = updates.role;
      }

      if (hubState.currentUser?.uid === targetUid) {
        hubState.currentUserProfile = buildOpsProfilePatch(
          hubState.currentUserProfile || {},
          email,
          nextAllowed
        );
        syncLoginCacheForOpsProfile(hubState.currentUser.uid, hubState.currentUserProfile);
        if (!hasAnyDirectEventAllow(nextAllowed)) clearOpsSessionSnapshot();
        scheduleHubTournamentsRender();
      }

      const requiredCode = String(tournament.requiredCode || "").trim();
      const userCode = String(user?.accessCode || "").trim();
      const stillAllowed =
        isAdminEmail(email) ||
        hasAnyDirectEventAllow(nextAllowed) ||
        (userCode && requiredCode && userCode === requiredCode);

      if (user && !stillAllowed) {
        const one = await cleanupUserFromLayoutState(user, eventId);
        cleaned.waitingRemoved += one.waitingRemoved;
        cleaned.seatRemoved += one.seatRemoved;
      }
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

export async function assignEventCodeToUser(uid, eventId, options = {}) {
  const silent = options.silent === true;
  const skipRender = options.skipRender === true;
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return { ok: false };
  if (!uid || !eventId) return { ok: false };

  try {
    const tournament = getTournamentById(eventId);
    if (!tournament) {
      if (!silent) alert("유효한 대회를 먼저 선택해주세요.");
      return { ok: false };
    }
    const requiredCode = String(tournament?.requiredCode || "").trim();

    if (!requiredCode) {
      if (!silent) alert("선택한 대회에 설정된 코드가 없습니다.");
      return { ok: false };
    }

    await updateDoc(doc(db, "users", uid), {
      accessCode: requiredCode
    });

    const user = hubState.usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = requiredCode;
    }

    if (!skipRender) {
      renderAdminUserList();
      syncAdminBulkSelectAllCheckbox();
    }
    if (!silent) alert(`유저 코드가 부여되었습니다: ${requiredCode}`);
    return { ok: true };
  } catch (err) {
    console.error(err);
    if (!silent) alert("유저 코드 부여에 실패했습니다.");
    return { ok: false };
  }
}

export async function removeUserCode(uid, options = {}) {
  const silent = options.silent === true;
  const skipRender = options.skipRender === true;
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return { ok: false };
  if (!uid) return { ok: false };

  try {
    await updateDoc(doc(db, "users", uid), {
      accessCode: ""
    });

    const user = hubState.usersCache.find((u) => u.uid === uid);
    if (user) {
      user.accessCode = "";
    }

    let cleaned = { waitingRemoved: 0, seatRemoved: 0 };
    const { adminEventSelect } = hubRefs;
    const selectedEventId = String(adminEventSelect?.value || "").trim();

    if (selectedEventId && user && !userStillHasAccessToSelectedEvent(user)) {
      cleaned = await cleanupUserFromLayoutState(user, selectedEventId);
    }

    if (!skipRender) {
      renderAdminUserList();
      syncAdminBulkSelectAllCheckbox();
    }

    if (!silent) {
      if (cleaned.waitingRemoved > 0 || cleaned.seatRemoved > 0) {
        alert(
          `유저 코드가 제거되었고, 대기 ${cleaned.waitingRemoved}건 / 좌석 ${cleaned.seatRemoved}건 정리되었습니다.`
        );
      } else {
        alert("유저 코드가 제거되었습니다.");
      }
    }
    return { ok: true, cleaned };
  } catch (err) {
    console.error(err);
    if (!silent) alert("유저 코드 제거에 실패했습니다.");
    return { ok: false };
  }
}

/** 체크된 유저들에 선택 대회의 공용 코드를 일괄 부여 */
export async function bulkAssignEventCodesToUsers(uids, eventId) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
  const uniq = [...new Set((uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uniq.length) {
    alert("먼저 유저를 선택해 주세요.");
    return;
  }
  const tournament = getTournamentById(eventId);
  const requiredCode = String(tournament?.requiredCode || "").trim();
  if (!tournament || !eventId) {
    alert("유효한 대회를 먼저 선택해주세요.");
    return;
  }
  if (!requiredCode) {
    alert("선택한 대회에 설정된 공용 코드가 없습니다. 대회 저장에서 코드를 넣어 주세요.");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const uid of uniq) {
    const r = await assignEventCodeToUser(uid, eventId, { silent: true, skipRender: true });
    if (r?.ok) ok += 1;
    else fail += 1;
  }

  renderAdminUserList();
  syncAdminBulkSelectAllCheckbox();

  alert(
    `${uniq.length}명 중 ${ok}명에게 코드「${requiredCode}」를 부여했습니다.` +
      (fail ? `\n(${fail}명은 건너뜀 또는 실패)` : "")
  );
}

/** 체크된 유저들의 접근 코드를 일괄 제거 */
export async function bulkRemoveUserCodes(uids) {
  if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) return;
  const uniq = [...new Set((uids || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!uniq.length) {
    alert("먼저 유저를 선택해 주세요.");
    return;
  }

  const okConfirm = confirm(`선택한 ${uniq.length}명의 코드를 제거할까요?`);
  if (!okConfirm) return;

  let ok = 0;
  let fail = 0;
  let totalWaiting = 0;
  let totalSeats = 0;

  for (const uid of uniq) {
    const r = await removeUserCode(uid, { silent: true, skipRender: true });
    if (r?.ok) {
      ok += 1;
      totalWaiting += r.cleaned?.waitingRemoved || 0;
      totalSeats += r.cleaned?.seatRemoved || 0;
    } else {
      fail += 1;
    }
  }

  renderAdminUserList();
  syncAdminBulkSelectAllCheckbox();

  let msg = `${uniq.length}명 중 ${ok}명의 코드를 제거했습니다.`;
  if (fail) msg += `\n(${fail}명 실패)`;
  if (totalWaiting > 0 || totalSeats > 0) {
    msg += `\n대기 ${totalWaiting}건 / 좌석 ${totalSeats}건 정리됨`;
  }
  alert(msg);
}

export function showUserCode(uid) {
  const user = hubState.usersCache.find((u) => u.uid === uid);
  if (!user) return;

  alert(`${user.nickname || "이름 없음"}\n접근 코드: ${user.accessCode || "없음"}`);
}
