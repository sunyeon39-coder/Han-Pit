import { getNowInAppTime, normalizeDateString, parseDateTime } from "./time-utils.js";
import { IX } from "./state.js";

export function getStatus(date, start, close) {
  const now = getNowInAppTime();
  const startTime = parseDateTime(date, start);
  const closeTime = parseDateTime(date, close);

  if (!startTime || !closeTime) return "scheduled";

  const openTime = new Date(startTime.getTime() - 30 * 60 * 1000);

  if (now < openTime) return "scheduled";
  if (now >= openTime && now < startTime) return "opened";
  if (now >= startTime && now < closeTime) return "running";
  return "closed";
}

export function getStatusLabel(status) {
  if (status === "scheduled") return "SCHEDULED";
  if (status === "opened") return "OPENED";
  if (status === "running") return "RUNNING";
  if (status === "closed") return "CLOSED";
  return "SCHEDULED";
}

export function normalizeEvents(docs) {
  return docs
    .map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        boxId: String(data.boxId || "").trim(),
        date: normalizeDateString(data.date || ""),
        title: String(data.title || d.id).trim(),
        start: String(data.start || "").trim(),
        close: String(data.close || "").trim()
      };
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.start.localeCompare(b.start);
    });
}

export function groupByDate(list) {
  const grouped = new Map();
  for (const item of list) {
    if (!grouped.has(item.date)) {
      grouped.set(item.date, []);
    }
    grouped.get(item.date).push(item);
  }
  return [...grouped.entries()];
}

export function buildSeatSummaryMap(docs) {
  const next = new Map();

  docs.forEach((d) => {
    const data = d.data() || {};
    const eventId = String(data.eventId || "").trim();
    const boxId = String(data.boxId || "").trim();
    const seats = Array.isArray(data.seats) ? data.seats : [];

    if (!eventId || !boxId) return;

    const totalSeats = seats.length;
    const occupiedSeats = seats.filter((seat) => {
      const person = String(seat?.person || "").trim();
      return person && person !== "비어있음";
    }).length;

    next.set(`${eventId}__${boxId}`, {
      totalSeats,
      occupiedSeats,
      emptySeats: Math.max(0, totalSeats - occupiedSeats)
    });
  });

  return next;
}

export function buildSeatSummaryMapFromGlobalSeats(docs) {
  const next = new Map();

  docs.forEach((d) => {
    const data = d.data() || {};
    const eventId = String(data.currentEventId || data.mappedEventId || "").trim();
    const boxId = String(data.boxId || "").trim();
    const seatId = String(data.seatId || "").trim();
    if (!eventId || !boxId || !seatId) return;

    const key = `${eventId}__${boxId}`;
    const prev = next.get(key) || { totalSeats: 0, occupiedSeats: 0, emptySeats: 0 };
    prev.totalSeats += 1;

    const person = String(data.person || "").trim();
    if (person && person !== "비어있음") {
      prev.occupiedSeats += 1;
    }
    prev.emptySeats = Math.max(0, prev.totalSeats - prev.occupiedSeats);
    next.set(key, prev);
  });

  return next;
}

export function getSeatSummary(eventId, boxId) {
  return IX.seatSummaryMap.get(`${eventId}__${boxId}`) || {
    totalSeats: 0,
    occupiedSeats: 0,
    emptySeats: 0
  };
}

export function formatSeatSummary(eventId, boxId) {
  const summary = getSeatSummary(eventId, boxId);

  if (summary.totalSeats <= 0) return "No Seats";
  return `${summary.totalSeats} Seats · ${summary.occupiedSeats} In Use`;
}
