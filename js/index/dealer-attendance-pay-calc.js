import { getOperationalDayKey } from "../shared/attendance-operational-day.js";

/** 프리랜서 사업소득 원천징수 (소득세 3% + 지방소득세 0.3%) */
export const FREELANCER_WITHHOLDING_RATE = 0.033;

export function freelancerWithholdingAmount(gross = 0) {
  const safe = Math.max(0, Math.round(Number(gross || 0)));
  if (!safe) return 0;
  return Math.floor(safe * FREELANCER_WITHHOLDING_RATE);
}

export function applyFreelancerWithholding(gross = 0) {
  const safe = Math.max(0, Math.round(Number(gross || 0)));
  if (!safe) return 0;
  return safe - freelancerWithholdingAmount(safe);
}

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
  let grossWorkTotal = 0;
  let withholdingTotal = 0;
  let workTotal = 0;

  for (const [key, ms] of [...msByDay.entries()].sort()) {
    let grossPay = 0;
    if (payMode === "daily") {
      grossPay = ms > 0 ? dailyRate : 0;
    } else {
      grossPay = Math.round((ms / 3_600_000) * hourlyRate);
    }
    const withholding = freelancerWithholdingAmount(grossPay);
    const pay = applyFreelancerWithholding(grossPay);
    grossWorkTotal += grossPay;
    withholdingTotal += withholding;
    workTotal += pay;
    days.push({
      key,
      label: formatSettlementDayLabel(key),
      ms,
      grossPay,
      withholding,
      pay
    });
  }

  return {
    days,
    extrasTotal,
    grossWorkTotal,
    withholdingTotal,
    workTotal,
    grandTotal: workTotal + extrasTotal
  };
}
