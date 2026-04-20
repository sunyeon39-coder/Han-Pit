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
