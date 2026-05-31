import { IX } from "./state.js";
import { getAttendanceDocId } from "./dealer-attendance-refs.js";
import { scheduleRenderDealerOps } from "./dealer-attendance-render.js";

export function snapshotAttendanceEntry(tournamentId = "", uid = "") {
  const docId = getAttendanceDocId(tournamentId, uid);
  const cur = IX.dealerAttendanceMap.get(docId);
  return cur ? { ...cur } : null;
}

export function applyOptimisticAttendanceEntry(tournamentId = "", uid = "", entry = null) {
  const docId = getAttendanceDocId(tournamentId, uid);
  if (!entry) {
    IX.dealerAttendanceMap.delete(docId);
  } else {
    IX.dealerAttendanceMap.set(docId, { ...entry });
  }
  scheduleRenderDealerOps();
}

export function restoreAttendanceSnapshot(tournamentId = "", uid = "", snapshot = null) {
  applyOptimisticAttendanceEntry(tournamentId, uid, snapshot);
}
