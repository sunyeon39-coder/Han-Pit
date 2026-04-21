import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { attendanceDocBelongsToTournament } from "./dealer-attendance-refs.js";
import { isAttendanceTerminal, seatStillMatchesActiveEventCard } from "./dealer-attendance-derived.js";

export function getAdminAttendanceList() {
  const tournamentId = getTournamentId();
  const list = [];

  IX.dealerAttendanceMap.forEach((value, docId) => {
    if (!attendanceDocBelongsToTournament(docId, tournamentId)) return;
    const seat = IX.dealerSeatMap.get(value.uid);
    const useSeat =
      Boolean(seat) && !isAttendanceTerminal(value.status) && seatStillMatchesActiveEventCard(seat);
    const derived = {
      ...value,
      ...(useSeat
        ? {
            status: "assigned",
            currentEventId: seat.eventId || "",
            currentBoxId: seat.boxId || "",
            currentSeatId: seat.seatId || "",
            currentSeatLabel: seat.seatLabel || ""
          }
        : {})
    };
    list.push(derived);
  });

  list.sort((a, b) => (a.nickname || "").localeCompare(b.nickname || "", "ko"));
  return list;
}

export function getFilteredAdminAttendanceList() {
  const base = getAdminAttendanceList();

  const keyword = IX.dealerAdminUi.search.trim().toLowerCase();
  let list = base.filter((item) => {
    const name = String(item.nickname || "").toLowerCase();
    const email = String(item.email || "").toLowerCase();
    const status = String(item.status || "off").trim();

    const matchKeyword =
      !keyword ||
      name.includes(keyword) ||
      email.includes(keyword);

    const matchStatus =
      IX.dealerAdminUi.status === "all" ||
      status === IX.dealerAdminUi.status;

    return matchKeyword && matchStatus;
  });

  if (IX.dealerAdminUi.sort === "name") {
    list.sort((a, b) =>
      String(a.nickname || "").localeCompare(String(b.nickname || ""), "ko")
    );
  }

  if (IX.dealerAdminUi.sort === "status") {
    const order = {
      waiting: 1,
      assigned: 2,
      checked_out: 3,
      off: 4
    };

    list.sort((a, b) => {
      const ao = order[String(a.status || "off")] ?? 99;
      const bo = order[String(b.status || "off")] ?? 99;
      if (ao !== bo) return ao - bo;
      return String(a.nickname || "").localeCompare(String(b.nickname || ""), "ko");
    });
  }

  if (IX.dealerAdminUi.sort === "recent") {
    list.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  return list;
}
