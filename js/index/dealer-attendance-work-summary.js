import { getTournamentId } from "./core-utils.js";
import { formatDuration } from "./dealer-attendance-format.js";
import { getWorkingMs } from "./dealer-attendance-derived.js";
import { getOperationalDayKey } from "../shared/attendance-operational-day.js";
import { attendanceLogCreatedAtMs } from "../shared/attendance-log-write.js";

const SESSION_START = new Set(["waiting", "checked_in"]);
const SESSION_DEDUPE_TOLERANCE_MS = 120_000;

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
  const key = String(adj.sessionKey || "").trim();
  if (key) {
    const byKey = sessions.findIndex((s) => String(s.sessionKey || "") === key);
    if (byKey >= 0) return byKey;
  }

  const prevStart = Number(adj.previousSessionStartMs || 0);
  const prevEnd = Number(adj.previousSessionEndMs || 0);
  if (!prevStart) return -1;

  const exact = sessions.findIndex((s) => {
    if (Number(s.startMs) !== prevStart) return false;
    if (s.open) return true;
    return Number(s.endMs) === prevEnd;
  });
  if (exact >= 0) return exact;

  return sessions.findIndex((s) => {
    if (!Number.isFinite(Number(s.startMs))) return false;
    if (Math.abs(Number(s.startMs) - prevStart) > 120_000) return false;
    if (s.open) return true;
    if (!prevEnd) return false;
    return Math.abs(Number(s.endMs) - prevEnd) <= 120_000;
  });
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
  const closeOpenSession = (endMs) => {
    if (openStart == null) return;
    const end = Math.max(Number(openStart), Number(endMs || openStart));
    sessions.push(withSessionKey({ startMs: openStart, endMs: end, open: false }));
    openStart = null;
    lastActivity = null;
  };

  for (const log of mine) {
    const action = String(log.action || "").trim();
    const at = Number(log.createdAt || 0) || 0;

    if (SESSION_START.has(action)) {
      // 이전 세션이 다른 운영일에서 안 닫혔으면(퇴근 누락) 먼저 자동 마감
      if (openStart != null && localDateKey(openStart) !== localDateKey(at)) {
        closeOpenSession(lastActivity ?? openStart);
      }
      if (openStart == null) openStart = at;
      lastActivity = at;
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
        const endMs = at || Date.now();
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

  const daySet = new Set();
  let totalMs = 0;

  dedupedSessions.forEach((s) => {
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
    sessions: dedupedSessions.sort((a, b) => Number(b.startMs) - Number(a.startMs)),
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
