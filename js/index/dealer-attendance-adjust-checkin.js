import { auth } from "../firebase.js";
import { setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { getAttendanceRef } from "./dealer-attendance-refs.js";
import { writeAttendanceLog } from "./dealer-attendance-logs.js";
import { getDerivedAttendance } from "./dealer-attendance-derived.js";
import { formatClock, getNowMs } from "./dealer-attendance-format.js";
import {
  applyOptimisticAttendanceEntry,
  restoreAttendanceSnapshot,
  snapshotAttendanceEntry
} from "./dealer-attendance-optimistic.js";

/**
 * 본인 출근 시각(checkedInAt) 수정 + 운영 로그 기록
 * @returns {boolean} 성공 여부
 */
export async function adjustMyCheckedInAt(newCheckedInAtMs) {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !IX.currentUserProfile) return false;

  const current = getDerivedAttendance(user);
  const previous = Number(current?.checkedInAt || 0);
  if (!previous) {
    alert("출근 기록이 없습니다. 먼저 출근하기를 눌러 주세요.");
    return false;
  }

  const next = Number(newCheckedInAtMs);
  if (!Number.isFinite(next) || next <= 0) {
    alert("올바른 출근 시각을 선택해 주세요.");
    return false;
  }

  if (next === previous) return true;

  const checkedOutAt = Number(current?.checkedOutAt || 0);
  if (checkedOutAt > 0 && next > checkedOutAt) {
    alert("출근 시각은 퇴근 시각보다 이후일 수 없습니다.");
    return false;
  }

  if (next > Date.now() + 60_000) {
    alert("출근 시각을 미래로 설정할 수 없습니다.");
    return false;
  }

  const nickname = String(IX.currentUserProfile.nickname || user.displayName || "").trim();
  const now = getNowMs();

  try {
    await setDoc(
      getAttendanceRef(tournamentId, user.uid),
      {
        checkedInAt: next,
        updatedAt: now
      },
      { merge: true }
    );

    await writeAttendanceLog({
      uid: user.uid,
      nickname,
      action: "adjust_check_in",
      tournamentId,
      eventId: current?.currentEventId || "",
      boxId: current?.currentBoxId || "",
      seatId: current?.currentSeatId || "",
      seatLabel: current?.currentSeatLabel || "",
      previousCheckedInAt: previous,
      newCheckedInAt: next,
      detail: `${formatClock(previous)} → ${formatClock(next)}`
    }).catch((err) => console.warn("writeAttendanceLog:", err));

    return true;
  } catch (err) {
    restoreAttendanceSnapshot(tournamentId, user.uid, prevSnap);
    console.error("adjustMyCheckedInAt error:", err);
    alert("출근 시각 변경에 실패했습니다.");
    return false;
  }
}

/**
 * 본인 퇴근 시각(checkedOutAt) 수정 + 운영 로그 기록
 * @returns {boolean} 성공 여부
 */
export async function adjustMyCheckedOutAt(newCheckedOutAtMs) {
  const tournamentId = getTournamentId();
  const user = auth.currentUser;
  if (!user || !tournamentId || !IX.currentUserProfile) return false;

  const current = getDerivedAttendance(user);
  const previous = Number(current?.checkedOutAt || 0);
  if (!previous) {
    alert("퇴근 기록이 없습니다. 먼저 퇴근하기를 눌러 주세요.");
    return false;
  }

  const next = Number(newCheckedOutAtMs);
  if (!Number.isFinite(next) || next <= 0) {
    alert("올바른 퇴근 시각을 선택해 주세요.");
    return false;
  }

  if (next === previous) return true;

  const checkedInAt = Number(current?.checkedInAt || 0);
  if (checkedInAt > 0 && next < checkedInAt) {
    alert("퇴근 시각은 출근 시각보다 이전일 수 없습니다.");
    return false;
  }

  if (next > Date.now() + 60_000) {
    alert("퇴근 시각을 미래로 설정할 수 없습니다.");
    return false;
  }

  const nickname = String(IX.currentUserProfile.nickname || user.displayName || "").trim();
  const now = getNowMs();
  const prevSnap = snapshotAttendanceEntry(tournamentId, user.uid);
  const nextEntry = {
    ...(prevSnap || {
      uid: user.uid,
      nickname,
      email: String(IX.currentUserProfile.email || user.email || "").trim(),
      tournamentId,
      status: current?.status || "off"
    }),
    checkedOutAt: next,
    updatedAt: now
  };
  applyOptimisticAttendanceEntry(tournamentId, user.uid, nextEntry);

  try {
    await setDoc(
      getAttendanceRef(tournamentId, user.uid),
      {
        checkedOutAt: next,
        updatedAt: now
      },
      { merge: true }
    );

    void writeAttendanceLog({
      uid: user.uid,
      nickname,
      action: "adjust_check_out",
      tournamentId,
      eventId: current?.currentEventId || "",
      boxId: current?.currentBoxId || "",
      seatId: current?.currentSeatId || "",
      seatLabel: current?.currentSeatLabel || "",
      previousCheckedOutAt: previous,
      newCheckedOutAt: next,
      detail: `${formatClock(previous)} → ${formatClock(next)}`
    }).catch((err) => console.warn("writeAttendanceLog:", err));

    return true;
  } catch (err) {
    restoreAttendanceSnapshot(tournamentId, user.uid, prevSnap);
    console.error("adjustMyCheckedOutAt error:", err);
    alert("퇴근 시각 변경에 실패했습니다.");
    return false;
  }
}
