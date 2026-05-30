import { getTournamentId } from "./core-utils.js";
import { formatDuration } from "./dealer-attendance-format.js";
import { getWorkingMs } from "./dealer-attendance-derived.js";

const SESSION_START = new Set(["waiting", "checked_in"]);

function localDateKey(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sessionDurationMs(session) {
  if (Number.isFinite(session.durationMs)) return Math.max(0, session.durationMs);
  return Math.max(0, Number(session.endMs || 0) - Number(session.startMs || 0));
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
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

  const sessions = [];
  let openStart = null;

  for (const log of mine) {
    const action = String(log.action || "").trim();
    if (SESSION_START.has(action)) {
      openStart = Number(log.createdAt || 0) || openStart;
    }
    if (action === "adjust_check_in") {
      const next = Number(log.newCheckedInAt || 0);
      if (next > 0) openStart = next;
    }
    if (action === "adjust_check_out") {
      const next = Number(log.newCheckedOutAt || 0);
      if (next > 0 && sessions.length) {
        const last = sessions[sessions.length - 1];
        if (!last.open) last.endMs = next;
      }
    }
    if (action === "checked_out" && openStart) {
      const endMs = Number(log.createdAt || 0) || Date.now();
      sessions.push({ startMs: openStart, endMs, open: false });
      openStart = null;
    }
  }

  const status = String(derived?.status || "").trim();
  const checkedInAt = Number(derived?.checkedInAt || 0);
  const checkedOutAt = Number(derived?.checkedOutAt || 0);
  const isOpen =
    checkedInAt > 0 && status !== "checked_out" && status !== "off";

  if (isOpen) {
    sessions.push({
      startMs: checkedInAt,
      endMs: Date.now(),
      durationMs: getWorkingMs(derived),
      open: true
    });
    openStart = null;
  } else if (openStart) {
    sessions.push({
      startMs: openStart,
      endMs: Date.now(),
      open: true
    });
  } else if (checkedInAt > 0 && checkedOutAt > 0 && status === "checked_out") {
    const dup = sessions.some((s) => Math.abs(Number(s.startMs) - checkedInAt) < 120_000);
    if (!dup) {
      sessions.push({
        startMs: checkedInAt,
        endMs: checkedOutAt,
        open: false
      });
    }
  }

  const daySet = new Set();
  let totalMs = 0;

  sessions.forEach((s) => {
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
    sessions: sessions.sort((a, b) => Number(b.startMs) - Number(a.startMs)),
    dayLabel: `${dayCount}일`,
    durationLabel: formatDuration(totalMs)
  };
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
