import { db } from "../firebase.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/** Firestore Timestamp / number 혼재 시 ms 로 통일 */
export function attendanceLogCreatedAtMs(value) {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function writeAttendanceLog({
  uid = "",
  nickname = "",
  action = "",
  tournamentId = "",
  eventId = "",
  boxId = "",
  seatId = "",
  seatLabel = "",
  previousCheckedInAt = null,
  newCheckedInAt = null,
  previousCheckedOutAt = null,
  newCheckedOutAt = null,
  sessionKey = "",
  previousSessionStartMs = null,
  newSessionStartMs = null,
  previousSessionEndMs = null,
  newSessionEndMs = null,
  detail = "",
  createdAt = null
}) {
  try {
    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      uid,
      nickname,
      action,
      tournamentId,
      eventId,
      boxId,
      seatId,
      seatLabel,
      // 호출자가 실제 상태 변경 시각(attendance 문서에 쓴 시각)을 넘겨주면 그 값을 사용한다.
      // 넘겨받지 못한 경우에만 fallback으로 지금 이 줄이 실행되는 시각을 쓴다 —
      // 이 함수는 setDoc 이후 await 없이 fire-and-forget 으로 호출되는 경우가 많아
      // 탭이 백그라운드로 넘어가는 등 실행이 지연되면 Date.now() 가 실제 클릭 시각과
      // 크게 어긋날 수 있다(근무 요약에 표시되는 종료 시각이 밀려 보이는 원인).
      createdAt: Number.isFinite(Number(createdAt)) && Number(createdAt) > 0 ? Number(createdAt) : Date.now()
    };
    if (previousCheckedInAt != null) payload.previousCheckedInAt = Number(previousCheckedInAt) || 0;
    if (newCheckedInAt != null) payload.newCheckedInAt = Number(newCheckedInAt) || 0;
    if (previousCheckedOutAt != null) payload.previousCheckedOutAt = Number(previousCheckedOutAt) || 0;
    if (newCheckedOutAt != null) payload.newCheckedOutAt = Number(newCheckedOutAt) || 0;
    if (String(sessionKey || "").trim()) payload.sessionKey = String(sessionKey).trim();
    if (previousSessionStartMs != null) {
      payload.previousSessionStartMs = Number(previousSessionStartMs) || 0;
    }
    if (newSessionStartMs != null) payload.newSessionStartMs = Number(newSessionStartMs) || 0;
    if (previousSessionEndMs != null) payload.previousSessionEndMs = Number(previousSessionEndMs) || 0;
    if (newSessionEndMs != null) payload.newSessionEndMs = Number(newSessionEndMs) || 0;
    if (String(detail || "").trim()) payload.detail = String(detail).trim();

    await setDoc(doc(db, "dealer_attendance_logs", logId), payload);
    return { id: logId, ...payload };
  } catch (err) {
    console.error("writeAttendanceLog error:", err);
    return null;
  }
}
