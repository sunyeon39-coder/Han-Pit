import { writeAttendanceLog } from "../shared/attendance-log-write.js";
import { GL } from "./state.js";

/** 통합배치도에서의 출석 상태 변경을 운영 로그에 남긴다. */
export function logGlobalLayoutAttendance({
  uid = "",
  nickname = "",
  action = "",
  eventId = "",
  boxId = "",
  seatId = "",
  seatLabel = "",
  detail = ""
} = {}) {
  const tournamentId = String(GL.tournamentId || "").trim();
  const safeAction = String(action || "").trim();
  if (!tournamentId || !safeAction) return;

  void writeAttendanceLog({
    uid: String(uid || "").trim(),
    nickname: String(nickname || "").trim(),
    action: safeAction,
    tournamentId,
    eventId: String(eventId || "").trim(),
    boxId: String(boxId || "").trim(),
    seatId: String(seatId || "").trim(),
    seatLabel: String(seatLabel || "").trim(),
    detail: String(detail || "").trim()
  }).catch((err) => console.warn("logGlobalLayoutAttendance:", err));
}
