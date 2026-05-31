import { isInactiveWaitingEntry } from "../shared/attendance-waiting-filter.js";

/**
 * 좌석 정체성·전역 병합 기준으로 "이미 앉았는지" 판별하고 표시용 대기 목록을 만든다.
 */
export function createSeatWaitingIdentityHelpers(ctx) {
  const {
    eventState,
    waitingState,
    TOURNAMENT_ID,
    isEmptyPerson,
    getSeatIdentity,
    getWaitingIdentity,
    getGlobalSeatsMerge,
    getAttendanceWaiting,
    getAttendanceInactiveUids,
    makeUid
  } = ctx;

  function isIdentitySeatedInEvent(identityKey) {
    if (!identityKey) return false;
    return eventState.seats.some((s) => {
      if (isEmptyPerson(s.person)) return false;
      return getSeatIdentity(s) === identityKey;
    });
  }

  /**
   * 대기 목록에서 숨김: (1) 이 화면 로컬 좌석에 앉음 (2) 다른 이벤트/박스 전역 좌석에 앉음
   * (3) 이 이벤트/박스 global_seats 에 person+personUid 로 확정된 배치 — 로컬 병합 전에도 대기 중복 완화
   */
  function isIdentitySeatedAnywhereInTournament(identityKey) {
    if (!identityKey) return false;
    if (isIdentitySeatedInEvent(identityKey)) return true;
    if (!TOURNAMENT_ID) return false;
    const merge = getGlobalSeatsMerge();
    if (!merge) return false;
    const outside =
      typeof merge.getGlobalSeatedIdentityKeysOutsideCurrentLayout === "function"
        ? merge.getGlobalSeatedIdentityKeysOutsideCurrentLayout()
        : null;
    if (outside && outside.has(identityKey)) return true;
    const onThisStrict =
      typeof merge.getGlobalSeatedIdentityKeysOnCurrentLayoutStrict === "function"
        ? merge.getGlobalSeatedIdentityKeysOnCurrentLayoutStrict()
        : null;
    if (onThisStrict && onThisStrict.has(identityKey)) return true;
    return false;
  }

  function matchesCurrentTournamentRow(w) {
    const cur = String(TOURNAMENT_ID || "").trim();
    if (!cur) return true;
    return String(w?.tournamentId || "").trim() === cur;
  }

  /**
   * 통합 배치도(global-layout/waiting.js getCurrentTournamentWaiting)와 동일 규칙:
   * 현재 대회 global_waiting 행만 + 앉지 않은 사람 + dealer_attendance waiting/checked_in 병합.
   */
  function getWaitingListForDisplay() {
    const inactive =
      typeof getAttendanceInactiveUids === "function"
        ? getAttendanceInactiveUids()
        : new Set();

    const waitingBase = waitingState.waiting
      .filter(matchesCurrentTournamentRow)
      .filter((w) => !isInactiveWaitingEntry(w, inactive))
      .filter((w) => !isIdentitySeatedAnywhereInTournament(getWaitingIdentity(w)));

    const merged = [...waitingBase];
    const attendanceList =
      typeof getAttendanceWaiting === "function" ? getAttendanceWaiting() : [];

    const hasEntry = (candidate = {}) => {
      const cUid = String(candidate.uid || "").trim();
      const cEmail = String(candidate.email || "").trim().toLowerCase();
      const cName = String(candidate.name || candidate.nickname || "").trim();
      return merged.some((w) => {
        const wUid = String(w?.uid || "").trim();
        const wEmail = String(w?.email || "").trim().toLowerCase();
        const wName = String(w?.name || "").trim();
        if (cUid && wUid && cUid === wUid) return true;
        if (cEmail && wEmail && cEmail === wEmail) return true;
        if (!cUid && !cEmail && cName && wName === cName) return true;
        return false;
      });
    };

    attendanceList.forEach((item) => {
      const uid = String(item?.uid || "").trim();
      const displayName =
        String(item.name || item.nickname || "").trim() || uid || "-";
      const personForSeat = {
        uid,
        email: item?.email,
        name: displayName
      };
      if (isIdentitySeatedAnywhereInTournament(getWaitingIdentity(personForSeat))) return;
      if (hasEntry(item)) return;
      merged.push({
        id: String(item.id || `att_${uid || makeUid("att")}`),
        uid,
        email: String(item.email || "").trim(),
        name: displayName,
        tournamentId: String(TOURNAMENT_ID || "").trim(),
        joinedAt: Number(item.statusChangedAt || item.checkedInAt || Date.now()) || Date.now(),
        source: "attendance_fallback"
      });
    });

    return merged;
  }

  function findSeatByIdentity(identityKey, excludeSeatId = "") {
    if (!identityKey) return null;

    return (
      eventState.seats.find((seat) => {
        if (excludeSeatId && seat.id === excludeSeatId) return false;
        if (isEmptyPerson(seat.person)) return false;
        return getSeatIdentity(seat) === identityKey;
      }) || null
    );
  }

  return {
    isIdentitySeatedInEvent,
    isIdentitySeatedAnywhereInTournament,
    getWaitingListForDisplay,
    findSeatByIdentity
  };
}
