import { auth } from "../firebase.js";
import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { formatClock, getNowMs } from "./dealer-attendance-format.js";
import { isAttendanceFromCurrentOperationalDay } from "../shared/attendance-operational-day.js";
import {
  applyOptimisticAttendanceEntry,
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";

const MATCH_TOLERANCE_MS = 120_000;

function timesNear(a, b) {
  return Math.abs(Number(a) - Number(b)) <= MATCH_TOLERANCE_MS;
}

function fail() {
  return { ok: false };
}

/**
 * 근무 요약 세션의 시작·종료 시각 수정 + 운영 로그 기록
 * 과거 구간은 운영 로그만 수정한다 — 출석 문서를 바꾸면 운영일 초기화가 발생할 수 있다.
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
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !IX.currentUserProfile) return fail();

  const prevStart = Number(previousStartMs);
  const prevEnd = Number(previousEndMs);
  const nextStart = Number(newStartMs);
  const nextEnd = Number(newEndMs);

  if (!Number.isFinite(nextStart) || nextStart <= 0) {
    alert("올바른 시작 시각을 선택해 주세요.");
    return fail();
  }

  if (!isOpen) {
    if (!Number.isFinite(nextEnd) || nextEnd <= 0) {
      alert("올바른 종료 시각을 선택해 주세요.");
      return fail();
    }
    if (nextEnd <= nextStart) {
      alert("종료 시각은 시작 시각보다 이후여야 합니다.");
      return fail();
    }
  }

  const now = getNowMs();
  if (nextStart > now + 60_000) {
    alert("시작 시각을 미래로 설정할 수 없습니다.");
    return fail();
  }
  if (!isOpen && nextEnd > now + 60_000) {
    alert("종료 시각을 미래로 설정할 수 없습니다.");
    return fail();
  }

  if (timesNear(nextStart, prevStart) && (isOpen || timesNear(nextEnd, prevEnd))) {
    return { ok: true, attendancePatched: false };
  }

  const current = getDerivedAttendance(user);
  const nickname = String(IX.currentUserProfile.nickname || user.displayName || "").trim();
  const prevSnap = snapshotAttendanceEntry(tournamentId, user.uid);

  const attendancePatch = {};
  const checkedInAt = Number(current?.checkedInAt || 0);

  // 현재 근무 중 세션의 시작만, 오늘 운영일 안에서 출석 문서와 동기화한다.
  if (
    isOpen &&
    checkedInAt > 0 &&
    timesNear(checkedInAt, prevStart) &&
    isAttendanceFromCurrentOperationalDay({ checkedInAt: nextStart }, now)
  ) {
    attendancePatch.checkedInAt = nextStart;
  }

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
