import { APP_TIME_ZONE } from "../app_config.js";

export function getNowPartsInAppTimeZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

export function getNowInAppTime() {
  const p = getNowPartsInAppTimeZone();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

export function normalizeDateString(date) {
  return String(date || "").trim().replaceAll(".", "-").replaceAll("/", "-");
}

export function parseDateTime(date, time) {
  const safeDate = normalizeDateString(date);
  const safeTime = String(time || "").trim();

  if (!safeDate || !safeTime) return null;

  const [yy, mm, dd] = safeDate.split("-").map(Number);
  const [hh, mi] = safeTime.split(":").map(Number);

  if (!yy || !mm || !dd) return null;
  if (!Number.isFinite(hh) || !Number.isFinite(mi)) return null;

  const d = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTitle(dateStr) {
  const safeDate = normalizeDateString(dateStr);
  const d = parseDateTime(safeDate, "00:00");
  if (!d) return String(dateStr || "Unknown Date");

  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    weekday: "long",
    year: "numeric"
  });
}

export function parseTournamentDate(str) {
  if (!str || typeof str !== "string") return null;

  const safe = normalizeDateString(str);
  const parts = safe.split("-");
  if (parts.length !== 3) return null;

  let yy = Number(parts[0]);
  const mm = Number(parts[1]);
  const dd = Number(parts[2]);

  if (!yy || !mm || !dd) return null;
  if (yy < 100) yy = 2000 + yy;

  return new Date(yy, mm - 1, dd, 23, 59, 59, 999);
}

export function isTournamentActive(tournament) {
  if (!tournament) return true;

  const now = getNowInAppTime();
  const start = parseTournamentDate(tournament.startDate);
  const end = parseTournamentDate(tournament.endDate);

  if (!start || !end) return true;

  const startOfDay = new Date(start);
  startOfDay.setHours(0, 0, 0, 0);

  return !(now < startOfDay || now > end);
}
