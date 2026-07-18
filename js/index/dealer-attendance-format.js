export function getAttendanceStatusLabel(status) {
  if (status === "checked_in") return "출근 완료";
  if (status === "waiting") return "대기";
  if (status === "assigned") return "배치중";
  if (status === "break") return "휴식";
  if (status === "checked_out") return "퇴근";
  return "출근 전";
}

/**
 * 초 단위를 버리고 "분"까지만 남긴다. toLocaleString/toLocaleTimeString 에
 * second 옵션을 안 넘기면 엔진(브라우저)에 따라 초를 버림(truncate)이 아니라
 * 반올림(round)해서 표시하는 경우가 있어 — 예: 01:30:31 → "01:31" — 총 근무시간은
 * ms를 그대로 floor 해서 계산하는 formatDuration과 어긋나 보이는 원인이 된다.
 * 화면 표시도 항상 floor 하도록 미리 초를 0으로 잘라서 넘긴다.
 */
function floorToMinute(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return n;
  return n - (n % 60000);
}

export function formatClock(ts) {
  if (!ts) return "-";
  const d = new Date(floorToMinute(ts));
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
  return new Date(floorToMinute(n)).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
