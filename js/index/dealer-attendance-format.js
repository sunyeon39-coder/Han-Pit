export function getAttendanceStatusLabel(status) {
  if (status === "checked_in") return "출근 완료";
  if (status === "waiting") return "대기";
  if (status === "assigned") return "배치중";
  if (status === "break") return "휴식";
  if (status === "checked_out") return "퇴근";
  return "출근 전";
}

export function formatClock(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatClockOrDash(ts) {
  return ts ? formatClock(ts) : "-";
}

export function formatDuration(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const totalMin = Math.floor(safe / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}시간 ${String(m).padStart(2, "0")}분`;
}

export function getNowMs() {
  return Date.now();
}

/** `<input type="datetime-local">` 값 ↔ ms (로컬 시간대) */
export function msToDatetimeLocalValue(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function datetimeLocalValueToMs(value) {
  const v = String(value || "").trim();
  if (!v) return NaN;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** 스크롤 피커·버튼 표시용 (년월일 시분) */
export function formatDatetimeKorean(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
