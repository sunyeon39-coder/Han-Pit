import { getOperationalDayKey } from "../shared/attendance-operational-day.js";

function sessionDurationMs(session = {}) {
  if (Number.isFinite(session?.durationMs)) return Math.max(0, Number(session.durationMs));
  const startMs = Number(session?.startMs || 0);
  const endMs = session?.open ? Date.now() : Number(session?.endMs || 0);
  if (!startMs || endMs <= startMs) return 0;
  return endMs - startMs;
}

function formatSettlementDayLabel(dayKey = "") {
  const parts = String(dayKey || "").split("-");
  if (parts.length !== 3) return String(dayKey || "");
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day) return String(dayKey || "");
  return `${month}/${day}`;
}

function collectMsByOperationalDay(sessions = []) {
  const map = new Map();
  for (const session of sessions || []) {
    const ms = sessionDurationMs(session);
    if (ms <= 0) continue;
    const key = getOperationalDayKey(Number(session.startMs || 0));
    map.set(key, (map.get(key) || 0) + ms);
  }
  return map;
}

export function wonLabel(amount = 0) {
  const value = Math.round(Number(amount || 0));
  if (!Number.isFinite(value) || value === 0) return "0원";
  return `${value.toLocaleString("ko-KR")}원`;
}

export function buildPayBreakdown(sessions = [], profile = {}) {
  const payMode = String(profile?.payMode || "hourly").trim() === "daily" ? "daily" : "hourly";
  const hourlyRate = Math.max(0, Number(profile?.hourlyRate || 0) || 0);
  const dailyRate = Math.max(0, Number(profile?.dailyRate || 0) || 0);
  const extras = Array.isArray(profile?.extras) ? profile.extras : [];
  const extrasTotal = extras.reduce(
    (sum, item) => sum + Math.max(0, Number(item?.amount || 0) || 0),
    0
  );

  const msByDay = collectMsByOperationalDay(sessions);
  const days = [];
  let workTotal = 0;

  for (const [key, ms] of [...msByDay.entries()].sort()) {
    let pay = 0;
    if (payMode === "daily") {
      pay = ms > 0 ? dailyRate : 0;
    } else {
      pay = Math.round((ms / 3_600_000) * hourlyRate);
    }
    workTotal += pay;
    days.push({
      key,
      label: formatSettlementDayLabel(key),
      ms,
      pay
    });
  }

  return {
    days,
    extrasTotal,
    workTotal,
    grandTotal: workTotal + extrasTotal
  };
}
