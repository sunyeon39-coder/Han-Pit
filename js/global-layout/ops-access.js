import { auth } from "../firebase.js";
import { GL } from "./state.js";
import { canShowTournamentOpsUi } from "../shared/tournament-ops-access.js";
import { globalLayoutTournamentMeta } from "./tournament-meta.js";

/** 시스템 admin · 허브「직접 허용」운영자 — 배치·BLOCK·삭제 등 통합 배치도 조작 */
export function canManageGlobalLayoutOps() {
  const user = GL.currentUser || auth.currentUser;
  if (!user?.uid || !GL.tournamentId) return false;
  if (GL.isAdminUser === true) return true;
  if (
    canShowTournamentOpsUi(
      user.email || "",
      GL.userProfile || {},
      GL.tournamentId,
      globalLayoutTournamentMeta(),
      user.uid
    )
  ) {
    return true;
  }
  return GL.opsServerVerified === true;
}

/** Seat 배치 이력 조회 — 직접 허용 운영자 포함(조작 권한과 별도) */
export function canViewGlobalLayoutSeatHistory(user = GL.currentUser || auth.currentUser) {
  if (canManageGlobalLayoutOps()) return true;
  if (!user?.uid || !GL.tournamentId) return false;
  return canShowTournamentOpsUi(
    user.email || "",
    GL.userProfile,
    GL.tournamentId,
    globalLayoutTournamentMeta(),
    user.uid
  );
}
