import { getTournamentId } from "./core-utils.js";
import { formatDuration } from "./dealer-attendance-format.js";
import { getWorkingMs } from "./dealer-attendance-derived.js";
import { getOperationalDayKey } from "../shared/attendance-operational-day.js";
import { attendanceLogCreatedAtMs } from "../shared/attendance-log-write.js";

const SESSION_START = new Set(["waiting", "checked_in"]);
const SESSION_DEDUPE_TOLERANCE_MS = 120_000;
// adjust_work_session / delete_work_session 은 딜러가 바닥에서 실제로 한 활동이 아니라
// 관리자가 과거 기록을 "고치는" 메타 로그다. 이 로그들은 별도 단계(applyWorkSessionAdjustments /
// applyWorkSessionDeletions)에서 처리하므로, 메인 루프의 "그 외 활동 → lastActivity 갱신"
// 폴백에 걸리면 안 된다. 걸리면 아직 checked_out 로그가 없는(=아직 open인) 세션의 종료
// 시각이 "방금 이 수정 로그를 쓴 시각"으로 계속 밀리는 버그가 생긴다 — 수정을 시도할
// 때마다 세션이 "지금"까지 늘어나 보이는 원인.
const NON_ACTIVITY_LOG_ACTIONS = new Set(["adjust_work_session", "delete_work_session"]);

function localDateKey(ms) {
  return getOperationalDayKey(Number(ms) || Date.now());
}

function sessionEndMs(session, nowMs = Date.now()) {
  if (session?.open) return nowMs;
  return Number(session?.endMs || 0);
}

function workSessionsAreDuplicate(a, b, nowMs = Date.now()) {
  const aStart = Number(a?.startMs || 0);
  const bStart = Number(b?.startMs || 0);
  const aEnd = sessionEndMs(a, nowMs);
  const bEnd = sessionEndMs(b, nowMs);
  if (!aStart || !bStart || !aEnd || !bEnd) return false;

  const sameEnd =
    Math.abs(aEnd - bEnd) <= SESSION_DEDUPE_TOLERANCE_MS &&
    (localDateKey(aStart) === localDateKey(bStart) || localDateKey(aEnd) === localDateKey(bEnd));
  if (sameEnd) return true;

  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  const shorterMs = Math.min(aEnd - aStart, bEnd - bStart);
  return shorterMs > 0 && overlapMs / shorterMs >= 0.85;
}

function mergeDuplicateWorkSessions(keep, drop) {
  keep.startMs = Math.max(Number(keep.startMs || 0), Number(drop.startMs || 0));
  if (!keep.open && !drop.open) {
    keep.endMs = Math.max(Number(keep.endMs || 0), Number(drop.endMs || 0));
  }
  keep.open = Boolean(keep.open || drop.open);
  delete keep.durationMs;
  // 병합 결과가 실제로 시간대를 가지면 더는 "무활동 유령 세션"이 아니다.
  keep.noActivityAutoClose =
    Boolean(keep.noActivityAutoClose) && Boolean(drop.noActivityAutoClose);
  keep.sessionKey = buildWorkSessionKey(keep);
  return keep;
}

function dedupeWorkSessions(sessions = [], nowMs = Date.now()) {
  const sorted = [...sessions].sort((a, b) => Number(a.startMs) - Number(b.startMs));
  const result = [];

  for (const session of sorted) {
    const dupIdx = result.findIndex((existing) => workSessionsAreDuplicate(existing, session, nowMs));
    if (dupIdx >= 0) {
      mergeDuplicateWorkSessions(result[dupIdx], session);
      continue;
    }
    result.push({ ...session });
  }

  return result.map((session) => withSessionKey(session));
}

function sessionAlreadyCoversRange(sessions, startMs, endMs, nowMs = Date.now()) {
  const start = Number(startMs || 0);
  const end = Number(endMs || 0);
  if (!start || !end) return false;

  return sessions.some((session) => {
    const candidate = session.open
      ? { ...session, endMs: end, open: false }
      : session;
    return workSessionsAreDuplicate(candidate, { startMs: start, endMs: end, open: false }, nowMs);
  });
}

function sessionDurationMs(session) {
  if (Number.isFinite(session.durationMs)) return Math.max(0, session.durationMs);
  return Math.max(0, Number(session.endMs || 0) - Number(session.startMs || 0));
}

export function buildWorkSessionKey(session) {
  const startMs = Number(session?.startMs || 0);
  if (session?.open) return `${startMs}_open`;
  const endMs = Number(session?.endMs || 0);
  return `${startMs}_${endMs}_closed`;
}

function withSessionKey(session) {
  return {
    ...session,
    sessionKey: buildWorkSessionKey(session)
  };
}

function findSessionForAdjustment(sessions, adj = {}) {
  const idx = sessions.findIndex((s) => sessionMatchesWorkSessionRef(s, adj));
  return idx;
}

function sessionMatchesWorkSessionRef(session, ref = {}) {
  const key = String(ref.sessionKey || "").trim();
  if (key && String(session.sessionKey || "") === key) return true;

  const prevStart = Number(ref.previousSessionStartMs || ref.newSessionStartMs || 0);
  const prevEnd = Number(ref.previousSessionEndMs || ref.newSessionEndMs || 0);
  if (!prevStart) return false;

  if (Number(session.startMs) === prevStart) {
    if (session.open) return true;
    return Number(session.endMs) === prevEnd;
  }

  if (Math.abs(Number(session.startMs) - prevStart) > SESSION_DEDUPE_TOLERANCE_MS) return false;
  if (session.open) return true;
  if (!prevEnd) return false;
  return Math.abs(Number(session.endMs) - prevEnd) <= SESSION_DEDUPE_TOLERANCE_MS;
}

function applyWorkSessionDeletions(sessions, logs = []) {
  const deletions = (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log.action || "").trim() === "delete_work_session")
    .sort((a, b) => attendanceLogCreatedAtMs(a.createdAt) - attendanceLogCreatedAtMs(b.createdAt));

  if (!deletions.length) return sessions;

  return sessions.filter(
    (session) => !deletions.some((del) => sessionMatchesWorkSessionRef(session, del))
  );
}

function applyWorkSessionAdjustments(sessions, logs = []) {
  const adjustments = (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log.action || "").trim() === "adjust_work_session")
    .sort((a, b) => attendanceLogCreatedAtMs(a.createdAt) - attendanceLogCreatedAtMs(b.createdAt));

  for (const adj of adjustments) {
    const idx = findSessionForAdjustment(sessions, adj);
    if (idx < 0) continue;

    const session = sessions[idx];
    const newStart = Number(adj.newSessionStartMs || 0);
    const newEnd = Number(adj.newSessionEndMs || 0);
    if (newStart > 0) session.startMs = newStart;
    if (newEnd > 0 && !session.open) session.endMs = newEnd;
    delete session.durationMs;
    // 관리자/본인이 직접 시각을 수정했다면 더는 "무활동 유령 세션"으로 취급하지 않는다.
    session.noActivityAutoClose = false;
    session.sessionKey = buildWorkSessionKey(session);
  }

  return sessions;
}

/**
 * 현재 대회·본인 기준 근무 일수·시간 (운영 로그 출근/퇴근 + 현재 출석 문서)
 */
export function computeMyTournamentWorkSummary(user, logs = [], derived = null) {
  const tournamentId = String(getTournamentId() || "").trim();
  const uid = String(user?.uid || "").trim();
  if (!tournamentId || !uid) {
    return { dayCount: 0, totalMs: 0, sessions: [], dayLabel: "0일", durationLabel: "0시간 00분" };
  }

  const mine = (Array.isArray(logs) ? logs : [])
    .filter(
      (log) =>
        String(log.uid || "").trim() === uid &&
        String(log.tournamentId || "").trim() === tournamentId
    )
    .sort((a, b) => attendanceLogCreatedAtMs(a.createdAt) - attendanceLogCreatedAtMs(b.createdAt));

  const sessions = [];
  let openStart = null;
  let lastActivity = null;

  // 퇴근을 안 누른 채 운영일이 바뀐 세션은 '마지막 활동 시점'으로 자동 마감해 누적에 포함한다.
  // 출근만 찍히고 그 사이 아무 활동도 없었다면 end === openStart(0분)가 되는데, 이 경우만
  // "유령 세션" 표시로 남겨서 이후 걸러낸다 — dedupe 등 다른 경로로 만들어진 세션은 절대
  // 건드리지 않는다(실제 근무 기록이 사라지지 않도록).
  const closeOpenSession = (endMs) => {
    if (openStart == null) return;
    const end = Math.max(Number(openStart), Number(endMs || openStart));
    sessions.push(
      withSessionKey({
        startMs: openStart,
        endMs: end,
        open: false,
        noActivityAutoClose: end <= Number(openStart)
      })
    );
    openStart = null;
    lastActivity = null;
  };

  for (const log of mine) {
    const action = String(log.action || "").trim();
    // adjust_work_session / delete_work_session 은 이 루프에서 완전히 건너뛴다 — 실제 세션
    // 재구성은 applyWorkSessionAdjustments/applyWorkSessionDeletions 가 별도로 처리하고,
    // 여기서 손대면 lastActivity 가 "수정 로그를 쓴 시각"으로 오염된다.
    if (NON_ACTIVITY_LOG_ACTIONS.has(action)) continue;
    const at = Number(log.createdAt || 0) || 0;
    // checked_in/checked_out 로그는 setDoc 이후 await 없이(fire-and-forget) 기록되는 경우가
    // 있어, 로그 문서가 실제로 쓰여진 시각(createdAt)이 백그라운드 탭 지연 등으로 실제
    // 출퇴근 시각과 어긋날 수 있다. attendance 문서에 반영한 실제 시각(newCheckedInAt /
    // newCheckedOutAt)이 있으면 그 값을 우선 사용한다.
    const sessionStartAt = Number(log.newCheckedInAt || 0) || at;

    if (SESSION_START.has(action)) {
      // 이전 세션이 다른 운영일에서 안 닫혔으면(퇴근 누락) 먼저 자동 마감
      if (openStart != null && localDateKey(openStart) !== localDateKey(sessionStartAt)) {
        closeOpenSession(lastActivity ?? openStart);
      }
      if (openStart == null) openStart = sessionStartAt;
      lastActivity = sessionStartAt;
      continue;
    }
    if (action === "adjust_check_in") {
      const next = Number(log.newCheckedInAt || 0);
      if (next > 0) {
        if (openStart != null) {
          openStart = next;
        } else {
          // 퇴근 후 출근 시각을 수정한 경우 — 이미 마감된 구간의 시작 시각을 갱신
          for (let i = sessions.length - 1; i >= 0; i -= 1) {
            const session = sessions[i];
            if (session.open) continue;
            const dayKey = localDateKey(next);
            if (localDateKey(session.startMs) !== dayKey && localDateKey(session.endMs) !== dayKey) continue;
            session.startMs = next;
            delete session.durationMs;
            session.sessionKey = buildWorkSessionKey(session);
            break;
          }
        }
      }
      if (at) lastActivity = at;
      continue;
    }
    if (action === "adjust_check_out") {
      const next = Number(log.newCheckedOutAt || 0);
      if (next > 0 && sessions.length) {
        const last = sessions[sessions.length - 1];
        if (!last.open) last.endMs = next;
      }
      continue;
    }
    if (action === "checked_out") {
      if (openStart != null) {
        const endMs = Number(log.newCheckedOutAt || 0) || at || Date.now();
        sessions.push(withSessionKey({ startMs: openStart, endMs, open: false }));
        openStart = null;
        lastActivity = null;
      }
      continue;
    }
    if (action === "operational_day_reset") {
      // 운영일 전환으로 비워진 세션 → 마지막 활동 시점으로 마감(누적 포함)
      closeOpenSession(lastActivity ?? openStart);
      continue;
    }
    // assigned/break 등 그 외 활동은 마지막 활동 시각만 갱신
    if (openStart != null && at) lastActivity = at;
  }

  const status = String(derived?.status || "").trim();
  const checkedInAt = Number(derived?.checkedInAt || 0);
  const checkedOutAt = Number(derived?.checkedOutAt || 0);
  const nowMs = Date.now();
  const isOpen =
    checkedInAt > 0 && status !== "checked_out" && status !== "off";

  if (isOpen) {
    const derivedOpen = withSessionKey({
      startMs: checkedInAt,
      endMs: nowMs,
      durationMs: getWorkingMs(derived),
      open: true
    });
    if (!sessions.some((s) => workSessionsAreDuplicate(s, derivedOpen, nowMs))) {
      sessions.push(derivedOpen);
    }
    openStart = null;
  } else if (
    openStart &&
    status === "checked_out" &&
    checkedOutAt > openStart &&
    Math.abs(Number(checkedInAt) - Number(openStart)) <= SESSION_DEDUPE_TOLERANCE_MS
  ) {
    // checked_out "액션 로그"는 없지만(예전 데이터, 기록 누락 등) attendance 문서 자체는
    // 이 출근 건이 실제로 퇴근 처리됐다고 말하고 있는 경우 — "마지막 활동 시점"으로 대충
    // 마감 추정하지 말고 문서의 진짜 퇴근 시각(checkedOutAt)을 그대로 쓴다. 이걸 안 하면
    // 아래 분기(lastActivity 기반 추정)로 빠져서, 이후 이 세션에 어떤 로그가 하나라도
    // 더 쓰이는 순간(수정 시도 포함) 종료 시각이 "그 로그를 쓴 시각"으로 계속 밀린다.
    sessions.push(withSessionKey({ startMs: openStart, endMs: checkedOutAt, open: false }));
  } else if (openStart) {
    // 로그상 아직 안 닫힌 세션. 이전 운영일이면 마지막 활동 시점으로 마감, 오늘이면 진행 중.
    if (localDateKey(openStart) !== localDateKey(Date.now())) {
      const end = Math.max(Number(openStart), Number(lastActivity ?? openStart));
      sessions.push(withSessionKey({ startMs: openStart, endMs: end, open: false }));
    } else {
      sessions.push(withSessionKey({ startMs: openStart, endMs: Date.now(), open: true }));
    }
  } else if (checkedInAt > 0 && checkedOutAt > 0 && status === "checked_out") {
    if (!sessionAlreadyCoversRange(sessions, checkedInAt, checkedOutAt, nowMs)) {
      sessions.push(
        withSessionKey({
          startMs: checkedInAt,
          endMs: checkedOutAt,
          open: false
        })
      );
    }
  }

  applyWorkSessionAdjustments(sessions, mine);
  const dedupedSessions = dedupeWorkSessions(sessions, nowMs);
  const deletedFiltered = applyWorkSessionDeletions(dedupedSessions, mine);
  // 출근만 찍고 아무 활동 없이 자동 마감된(운영일 전환 등) 0분짜리 유령 세션만 제외한다.
  // 반드시 closeOpenSession 에서 명시적으로 표시된 것만 걸러내고, dedupe 등 다른 경로로
  // 만들어진 세션은 duration 값만 보고 추측해서 지우지 않는다 — 실제 근무 기록이
  // 잘못 사라지는 것을 막기 위함.
  const visibleSessions = deletedFiltered.filter((s) => !s.noActivityAutoClose);

  const daySet = new Set();
  let totalMs = 0;

  visibleSessions.forEach((s) => {
    const ms = sessionDurationMs(s);
    totalMs += ms;
    const dk1 = localDateKey(s.startMs);
    const dk2 = localDateKey(s.endMs);
    if (dk1) daySet.add(dk1);
    if (dk2) daySet.add(dk2);
  });

  const dayCount = daySet.size;
  return {
    dayCount,
    totalMs,
    sessions: visibleSessions.sort((a, b) => Number(b.startMs) - Number(a.startMs)),
    dayLabel: `${dayCount}일`,
    durationLabel: formatDuration(totalMs)
  };
}

export function formatWorkSessionDuration(session) {
  return formatDuration(sessionDurationMs(session));
}

export function formatWorkSessionRange(session) {
  const fmt = (ms) => {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return "-";
    return d.toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  };
  const start = fmt(session.startMs);
  const end = session.open ? "진행 중" : fmt(session.endMs);
  const dur = formatDuration(sessionDurationMs(session));
  return `${start} ~ ${end} · ${dur}`;
}
