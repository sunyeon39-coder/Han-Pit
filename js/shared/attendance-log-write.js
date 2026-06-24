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
  detail = ""
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
      createdAt: Date.now()
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
