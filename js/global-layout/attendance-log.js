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
  const safeUid = String(uid || "").trim();
  // dealer_attendance_logs 규칙은 uid가 비어 있으면 admin이어도 create를 거부한다(로그를
  // 특정 근무자에게 귀속시킬 수 없으면 인건비·근무 요약 근거로 의미가 없기 때문) — 계정 없이
  // 수동 추가된 대기자(uid 없음)를 배치할 때 이 상태로 흔히 걸려 콘솔에 permission-denied만
  // 남고 조용히 실패했다. 애초에 기록할 수 없는 로그이므로 쓰기 자체를 건너뛴다.
  if (!tournamentId || !safeAction || !safeUid) return;

  void writeAttendanceLog({
    uid: safeUid,
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
