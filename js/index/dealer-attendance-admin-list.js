import { getTournamentId } from "./core-utils.js";
import { IX } from "./state.js";
import { attendanceDocBelongsToTournament } from "./dealer-attendance-refs.js";
import { applyOperationalDayToAttendance } from "../shared/attendance-operational-day.js";
import {
  buildTournamentWaitingDisplayList,
  buildIndexAttendanceInactiveUids,
  buildIndexAttendanceWaitingRows
} from "../shared/tournament-waiting-queue.js";

function buildOpsWaitingIndex(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const waitingList = buildTournamentWaitingDisplayList({
    globalWaiting: IX.globalWaiting,
    tournamentId: tid,
    attendanceInactiveUids: buildIndexAttendanceInactiveUids(IX.dealerAttendanceMap, tid),
    globalSeats: IX.dealerGlobalSeats,
    attendanceFilterReady: IX.dealerAttendanceMap.size > 0,
    attendanceWaitingRows: buildIndexAttendanceWaitingRows(IX.dealerAttendanceMap, tid)
  });

  const byUid = new Map();
  const byEmail = new Map();
  const byName = new Map();
  for (const row of waitingList) {
    const uid = String(row?.uid || "").trim();
    if (uid) byUid.set(uid, row);
    const email = String(row?.email || "").trim().toLowerCase();
    if (email) byEmail.set(email, row);
    const name = String(row?.name || row?.nickname || "").trim();
    if (name) byName.set(name, row);
  }
  return { byUid, byEmail, byName };
}

function findOpsWaitingRow(item = {}, opsIndex = null) {
  if (!opsIndex) return null;
  const uid = String(item?.uid || "").trim();
  const email = String(item?.email || "").trim().toLowerCase();
  const name = String(item?.nickname || item?.name || "").trim();
  if (uid && opsIndex.byUid.has(uid)) return opsIndex.byUid.get(uid);
  if (email && opsIndex.byEmail.has(email)) return opsIndex.byEmail.get(email);
  if (name && opsIndex.byName.has(name)) return opsIndex.byName.get(name);
  return null;
}

/** 출석 문서 + 통합배치도(대기·좌석) 기준 — Admin 목록에 보이는 실제 운영 상태 */
function applyOpsStatusOverlay(item = {}, opsIndex = null) {
  const uid = String(item?.uid || "").trim();
  const status = String(item?.status || "off").trim();
  if (status === "checked_out") return item;

  const seat = uid ? IX.dealerSeatMap.get(uid) : null;
  if (seat) {
    return {
      ...item,
      status: "assigned",
      checkedOutAt: null,
      currentEventId: seat.eventId || item.currentEventId || "",
      currentBoxId: seat.boxId || item.currentBoxId || "",
      currentSeatId: seat.seatId || item.currentSeatId || "",
      currentSeatLabel: seat.seatLabel || item.currentSeatLabel || ""
    };
  }

  const waitRow = findOpsWaitingRow(item, opsIndex);
  if (!waitRow) return item;

  const joinMs =
    Number(
      waitRow.joinedAt ||
        waitRow.createdAt ||
        waitRow.joinedAtServer ||
        waitRow.addedAt ||
        0
    ) || null;

  return {
    ...item,
    status: "waiting",
    checkedInAt: item.checkedInAt || joinMs,
    checkedOutAt: null,
    statusChangedAt: item.statusChangedAt || joinMs,
    currentEventId: "",
    currentBoxId: "",
    currentSeatId: "",
    currentSeatLabel: ""
  };
}

function deriveAdminAttendanceRow(raw = {}, opsIndex = null) {
  const normalized = applyOperationalDayToAttendance(raw);
  return applyOpsStatusOverlay(normalized, opsIndex);
}

export function getAdminAttendanceList() {
  const tournamentId = getTournamentId();
  const list = [];
  const seenUids = new Set();
  const opsIndex = buildOpsWaitingIndex(tournamentId);

  IX.dealerAttendanceMap.forEach((value, docId) => {
    if (!attendanceDocBelongsToTournament(docId, tournamentId)) return;
    const derived = deriveAdminAttendanceRow(value, opsIndex);
    if (derived.uid) seenUids.add(String(derived.uid).trim());
    list.push(derived);
  });

  IX.tournamentRosterMap.forEach((roster, uid) => {
    const safeUid = String(uid || "").trim();
    if (!safeUid || seenUids.has(safeUid)) return;
    list.push(
      deriveAdminAttendanceRow(
        {
          uid: safeUid,
          nickname: roster.nickname || "",
          email: roster.email || "",
          tournamentId,
          status: "off",
          checkedInAt: null,
          checkedOutAt: null,
          breakStartedAt: null,
          totalBreakMs: 0,
          currentEventId: "",
          currentBoxId: "",
          currentSeatId: "",
          currentSeatLabel: "",
          updatedAt: 0
        },
        opsIndex
      )
    );
  });

  list.sort((a, b) => (a.nickname || "").localeCompare(b.nickname || "", "ko"));
  return list;
}

function normalizeDealerAdminKeyword(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || /^[\s\-._]+$/.test(s)) return "";
  return s;
}

export function getFilteredAdminAttendanceList() {
  const base = getAdminAttendanceList();

  const keyword = normalizeDealerAdminKeyword(IX.dealerAdminUi.search);
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
