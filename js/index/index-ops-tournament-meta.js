import { canUseTournamentOps } from "../shared/auth-helpers.js";
import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";

/** allowedEvents 이름·로고 별칭 매칭 — load/bind 시점에도 indexTournamentMeta() 와 동일 */
export function resolveIndexOpsTournamentMeta() {
  const t = IX.currentTournament;
  if (t?.id) {
    return { id: t.id, name: t.name, logoText: t.logoText };
  }
  const tid = getTournamentId();
  if (!tid) return null;
  const cachedName = sessionStorage.getItem(`tournamentName:${tid}`);
  if (cachedName) return { id: tid, name: cachedName, logoText: "" };
  return { id: tid };
}

export function indexCanUseTournamentOps(user = null) {
  const tid = getTournamentId();
  if (!tid || !user?.uid) return false;
  return canUseTournamentOps(
    user.email || "",
    IX.currentUserProfile,
    tid,
    resolveIndexOpsTournamentMeta()
  );
}
