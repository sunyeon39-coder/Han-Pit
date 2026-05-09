import { makeUid } from "./layout-core-utils.js";
import { getWaitingTimerStartMs } from "./layout-main-waiting-time.js";

export function normalizeWaitingName(name = "") {
  return String(name || "").trim().slice(0, 30);
}

export function normalizeWaitingEntry(raw, tournamentId) {
  if (!raw || typeof raw !== "object") return null;

  const id = String(raw.id || makeUid("wait")).trim();
  const name = String(raw.name || "").trim();
  if (!name) return null;

  return {
    id,
    name,
    uid: String(raw.uid || "").trim(),
    email: String(raw.email || "").trim(),
    tournamentId: String(raw.tournamentId || tournamentId || "").trim(),
    addedAt: getWaitingTimerStartMs(raw),
    carryStartedAt: raw.carryStartedAt ? Number(raw.carryStartedAt) : null,
    blockChecked: raw.blockChecked === true,
    blockCheckedAt: raw.blockCheckedAt ? Number(raw.blockCheckedAt) : null,
    blockAccumulatedMs: raw.blockAccumulatedMs ? Number(raw.blockAccumulatedMs) : 0
  };
}

export function sortWaitingAscending(list, getStartMs = getWaitingTimerStartMs) {
  return [...list].sort((a, b) => getStartMs(a) - getStartMs(b));
}
