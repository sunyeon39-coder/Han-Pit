import { isEmptyPerson } from "./layout-core-utils.js";

export function pickDisplayName(profile, user) {
  const nick = String(profile?.nickname || "").trim();
  if (nick) return nick;

  const displayName = String(user?.displayName || "").trim();
  if (displayName) return displayName;

  const email = String(profile?.email || user?.email || "").trim();
  if (email) return email.split("@")[0];

  return "Dealer";
}

/**
 * 패널·모바일 좌석 줄 앞 뱃지: 캔버스 `SEAT {label}`과 동일하게 label 우선(영문·혼합 포함),
 * 라벨이 비었을 때만 내부 순번 no 표시.
 */
export function seatCanvasDigitsOnly(label, no) {
  const l = String(label ?? "").trim();
  if (l) return l;
  const nStr = no != null && no !== "" ? String(no).trim() : "";
  if (nStr) return nStr;
  return "—";
}

export function compareSeatsByCanvasLabel(a = {}, b = {}) {
  const la = seatCanvasDigitsOnly(a.label, a.no);
  const lb = seatCanvasDigitsOnly(b.label, b.no);
  const cmp = la.localeCompare(lb, undefined, { numeric: true, sensitivity: "base" });
  if (cmp !== 0) return cmp;
  return (a.order ?? a.no ?? 0) - (b.order ?? b.no ?? 0);
}

export function getSortedSeats(list = [], seatSortMode, isEmptyPersonFn = isEmptyPerson) {
  const seats = [...list];

  if (seatSortMode === "time") {
    return seats.sort((a, b) => {
      const aOccupied = !isEmptyPersonFn(a.person);
      const bOccupied = !isEmptyPersonFn(b.person);

      if (aOccupied !== bOccupied) return aOccupied ? -1 : 1;

      if (!aOccupied && !bOccupied) {
        return compareSeatsByCanvasLabel(a, b);
      }

      const aTime = Number(a.seatedAt || 0);
      const bTime = Number(b.seatedAt || 0);
      if (aTime !== bTime) return aTime - bTime;

      return compareSeatsByCanvasLabel(a, b);
    });
  }

  return seats.sort(compareSeatsByCanvasLabel);
}
