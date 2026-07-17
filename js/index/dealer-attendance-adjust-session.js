import { auth } from "../firebase.js";
import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef, getAttendanceDocId } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { formatClock, getNowMs } from "./dealer-attendance-format.js";
import { isAttendanceFromCurrentOperationalDay } from "../shared/attendance-operational-day.js";
import {
  applyOptimisticAttendanceEntry,
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";

const MATCH_TOLERANCE_MS = 120_000;

function canAdjustAttendanceTimes() {
  const user = auth.currentUser;
  const tournamentId = getTournamentId();
  const t = IX.currentTournament;
  return canShowTournamentOpsUi(
    user?.email,
    IX.currentUserProfile,
    tournamentId,
    t ? { id: t.id, name: t.name, logoText: t.logoText } : null,
    user?.uid
  );
}

function timesNear(a, b) {
  return Math.abs(Number(a) - Number(b)) <= MATCH_TOLERANCE_MS;
}

function samePickerTime(a, b) {
  return Number(a) === Number(b);
}

function fail() {
  return { ok: false, log: null };
}

function buildAttendancePatchForSessionEdit({
  current = null,
  prevStart = 0,
  prevEnd = 0,
  nextStart = 0,
  nextEnd = 0,
  isOpen = false,
  now = Date.now()
} = {}) {
  const patch = {};
  const checkedInAt = Number(current?.checkedInAt || 0);
  const checkedOutAt = Number(current?.checkedOutAt || 0);

  if (
    isOpen &&
    checkedInAt > 0 &&
    timesNear(checkedInAt, prevStart) &&
    isAttendanceFromCurrentOperationalDay({ checkedInAt: nextStart }, now)
  ) {
    patch.checkedInAt = nextStart;
  }

  if (
    !isOpen &&
    checkedOutAt > 0 &&
    timesNear(checkedOutAt, prevEnd) &&
    isAttendanceFromCurrentOperationalDay({ checkedOutAt: nextEnd }, now)
  ) {
    patch.checkedOutAt = nextEnd;
  }

  if (
    !isOpen &&
    checkedInAt > 0 &&
    timesNear(checkedInAt, prevStart) &&
    isAttendanceFromCurrentOperationalDay({ checkedInAt: nextStart }, now)
  ) {
    patch.checkedInAt = nextStart;
  }

  return patch;
}

function validateWorkSessionEdit({
  previousStartMs = 0,
  previousEndMs = 0,
  newStartMs = 0,
  newEndMs = 0,
  isOpen = false
} = {}) {
  const prevStart = Number(previousStartMs);
  const prevEnd = Number(previousEndMs);
  const nextStart = Number(newStartMs);
  const nextEnd = Number(newEndMs);

  if (!Number.isFinite(nextStart) || nextStart <= 0) {
    alert("올바른 시작 시각을 선택해 주세요.");
    return null;
  }

  if (!isOpen) {
    if (!Number.isFinite(nextEnd) || nextEnd <= 0) {
      alert("올바른 종료 시각을 선택해 주세요.");
      return null;
    }
    if (nextEnd <= nextStart) {
      alert("종료 시각은 시작 시각보다 이후여야 합니다.");
      return null;
    }
  }

  const now = getNowMs();
  if (nextStart > now + 60_000) {
    alert("시작 시각을 미래로 설정할 수 없습니다.");
    return null;
  }
  if (!isOpen && nextEnd > now + 60_000) {
    alert("종료 시각을 미래로 설정할 수 없습니다.");
    return null;
  }

  if (samePickerTime(nextStart, prevStart) && (isOpen || samePickerTime(nextEnd, prevEnd))) {
    return { noop: true, prevStart, prevEnd, nextStart, nextEnd };
  }

  return { noop: false, prevStart, prevEnd, nextStart, nextEnd };
}

/**
 * 근무 요약 세션의 시작·종료 시각 수정 + 운영 로그 기록
 * @returns {Promise<{ok: boolean, attendancePatched?: boolean}>}
 */
export async function adjustMyWorkSession({
  sessionKey = "",
  previousStartMs = 0,
  previousEndMs = 0,
  newStartMs = 0,
  newEndMs = 0,
  isOpen = false
} = {}) {
  if (!canAdjustAttendanceTimes()) return fail();

  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !IX.currentUserProfile) return fail();

  const validated = validateWorkSessionEdit({
    previousStartMs,
    previousEndMs,
    newStartMs,
    newEndMs,
    isOpen
  });
  if (!validated) return fail();
  if (validated.noop) return { ok: true, log: null, attendancePatched: false };

  const { prevStart, prevEnd, nextStart, nextEnd } = validated;
  const now = getNowMs();
  const current = getDerivedAttendance(user);
  const nickname = String(IX.currentUserProfile.nickname || user.displayName || "").trim();
  const prevSnap = snapshotAttendanceEntry(tournamentId, user.uid);

  const attendancePatch = buildAttendancePatchForSessionEdit({
    current,
    prevStart,
    prevEnd,
    nextStart,
    nextEnd,
    isOpen,
    now
  });

  if (Object.keys(attendancePatch).length) {
    applyOptimisticAttendanceEntry(tournamentId, user.uid, {
      ...(prevSnap || {
        uid: user.uid,
        nickname,
        email: String(IX.currentUserProfile.email || user.email || "").trim(),
        tournamentId,
        status: current?.status || "off"
      }),
      ...attendancePatch,
      updatedAt: now
    });
  }

  try {
    if (Object.keys(attendancePatch).length) {
      await setDoc(
        getAttendanceRef(tournamentId, user.uid),
        { ...attendancePatch, updatedAt: now },
        { merge: true }
      );
    }

    const detailParts = [`시작 ${formatClock(prevStart)} → ${formatClock(nextStart)}`];
    if (!isOpen) {
      detailParts.push(`종료 ${formatClock(prevEnd)} → ${formatClock(nextEnd)}`);
    }

    const log = await writeAttendanceLog({
      uid: user.uid,
      nickname,
      action: "adjust_work_session",
      tournamentId,
      eventId: current?.currentEventId || "",
      boxId: current?.currentBoxId || "",
      seatId: current?.currentSeatId || "",
      seatLabel: current?.currentSeatLabel || "",
      sessionKey: String(sessionKey || "").trim(),
      previousSessionStartMs: prevStart,
      newSessionStartMs: nextStart,
      previousSessionEndMs: isOpen ? 0 : prevEnd,
      newSessionEndMs: isOpen ? 0 : nextEnd,
      detail: detailParts.join(" · ")
    });

    return {
      ok: !!log,
      log,
      attendancePatched: Object.keys(attendancePatch).length > 0
    };
  } catch (err) {
    if (Object.keys(attendancePatch).length) {
      restoreAttendanceSnapshot(tournamentId, user.uid, prevSnap);
    }
    console.error("adjustMyWorkSession error:", err);
    alert("근무 시간 수정에 실패했습니다.");
    return fail();
  }
}

/**
 * admin — 타인 근무 구간 수정 (운영 로그만, 출석 문서는 변경하지 않음)
 * @returns {Promise<{ok: boolean, attendancePatched?: boolean}>}
 */
export async function adjustUserWorkSession({
  targetUid = "",
  targetNickname = "",
  sessionKey = "",
  previousStartMs = 0,
  previousEndMs = 0,
  newStartMs = 0,
  newEndMs = 0,
  isOpen = false
} = {}) {
  if (!canAdjustAttendanceTimes()) return fail();

  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  const safeUid = String(targetUid || "").trim();
  if (!user || !tournamentId || !safeUid) return fail();

  const validated = validateWorkSessionEdit({
    previousStartMs,
    previousEndMs,
    newStartMs,
    newEndMs,
    isOpen
  });
  if (!validated) return fail();
  if (validated.noop) return { ok: true, log: null, attendancePatched: false };

  const { prevStart, prevEnd, nextStart, nextEnd } = validated;
  const adminName = String(IX.currentUserProfile?.nickname || user.displayName || "").trim();
  const now = getNowMs();
  const targetEntry =
    IX.dealerAttendanceMap.get(getAttendanceDocId(tournamentId, safeUid)) || null;
  const prevSnap = snapshotAttendanceEntry(tournamentId, safeUid);
  const attendancePatch = buildAttendancePatchForSessionEdit({
    current: targetEntry,
    prevStart,
    prevEnd,
    nextStart,
    nextEnd,
    isOpen,
    now
  });

  if (Object.keys(attendancePatch).length) {
    applyOptimisticAttendanceEntry(tournamentId, safeUid, {
      ...(prevSnap || {
        uid: safeUid,
        nickname: String(targetNickname || "").trim(),
        tournamentId,
        status: targetEntry?.status || "off"
      }),
      ...attendancePatch,
      updatedAt: now
    });
  }

  const detailParts = [`시작 ${formatClock(prevStart)} → ${formatClock(nextStart)}`];
  if (!isOpen) {
    detailParts.push(`종료 ${formatClock(prevEnd)} → ${formatClock(nextEnd)}`);
  }
  if (adminName) {
    detailParts.push(`관리자 ${adminName} 수정`);
  }

  try {
    if (Object.keys(attendancePatch).length) {
      await setDoc(
        getAttendanceRef(tournamentId, safeUid),
        { ...attendancePatch, updatedAt: now },
        { merge: true }
      );
    }

    const log = await writeAttendanceLog({
      uid: safeUid,
      nickname: String(targetNickname || "").trim(),
      action: "adjust_work_session",
      tournamentId,
      sessionKey: String(sessionKey || "").trim(),
      previousSessionStartMs: prevStart,
      newSessionStartMs: nextStart,
      previousSessionEndMs: isOpen ? 0 : prevEnd,
      newSessionEndMs: isOpen ? 0 : nextEnd,
      detail: detailParts.join(" · ")
    });

    return { ok: !!log, log, attendancePatched: Object.keys(attendancePatch).length > 0 };
  } catch (err) {
    if (Object.keys(attendancePatch).length) {
      restoreAttendanceSnapshot(tournamentId, safeUid, prevSnap);
    }
    console.error("adjustUserWorkSession error:", err);
    alert("근무 시간 수정에 실패했습니다.");
    return fail();
  }
}

/**
 * admin — 중복·겹침 근무 구간 중 하나 삭제 (운영 로그만, 집계에서 제외)
 * @returns {Promise<{ok: boolean}>}
 */
export async function deleteUserWorkSession({
  targetUid = "",
  targetNickname = "",
  sessionKey = "",
  previousStartMs = 0,
  previousEndMs = 0,
  isOpen = false
} = {}) {
  if (!canAdjustAttendanceTimes()) return fail();

  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  const safeUid = String(targetUid || "").trim();
  if (!user || !tournamentId || !safeUid) return fail();

  const prevStart = Number(previousStartMs || 0);
  const prevEnd = Number(previousEndMs || 0);
  if (!prevStart) {
    alert("삭제할 근무 구간을 찾을 수 없습니다.");
    return fail();
  }
  if (isOpen) {
    alert("진행 중인 근무 구간은 삭제할 수 없습니다.");
    return fail();
  }
  if (!prevEnd || prevEnd <= prevStart) {
    alert("종료 시각이 없는 근무 구간은 삭제할 수 없습니다.");
    return fail();
  }

  const adminName = String(IX.currentUserProfile?.nickname || user.displayName || "").trim();
  const detailParts = [
    `시작 ${formatClock(prevStart)} · 종료 ${formatClock(prevEnd)}`
  ];
  if (adminName) {
    detailParts.push(`관리자 ${adminName} 삭제`);
  }

  try {
    const log = await writeAttendanceLog({
      uid: safeUid,
      nickname: String(targetNickname || "").trim(),
      action: "delete_work_session",
      tournamentId,
      sessionKey: String(sessionKey || "").trim(),
      previousSessionStartMs: prevStart,
      previousSessionEndMs: prevEnd,
      detail: detailParts.join(" · ")
    });

    return { ok: !!log, log };
  } catch (err) {
    console.error("deleteUserWorkSession error:", err);
    alert("근무 구간 삭제에 실패했습니다.");
    return fail();
  }
}
