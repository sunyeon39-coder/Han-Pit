import { GL } from "./state.js";
import { isEmptyPerson, makeUid } from "./utils.js";

export function isPersonSeatedInGlobalSeats(seats, person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim().toLowerCase();
  const name = String(person.name || person.nickname || "").trim();
  return seats.some((s) => {
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    const pUid = String(s?.personUid || "").trim();
    const pEmail = String(s?.personEmail || "").trim().toLowerCase();
    const pName = String(s?.person || "").trim();
    if (uid && pUid && uid === pUid) return true;
    if (email && pEmail && email === pEmail) return true;
    if (!uid && !email && name && pName === name) return true;
    return false;
  });
}

export function getCurrentTournamentWaiting() {
  const inactive = GL.attendanceInactiveUids instanceof Set ? GL.attendanceInactiveUids : new Set();

  const waitingBase = GL.globalWaiting
    .filter((w) => String(w?.tournamentId || "").trim() === GL.tournamentId)
    .filter((w) => {
      const uid = String(w?.uid || "").trim();
      if (uid && inactive.has(uid)) return false;
      return true;
    })
    .filter((w) =>
      !isPersonSeatedInGlobalSeats(GL.globalSeats, {
        uid: w?.uid,
        email: w?.email,
        name: w?.name
      })
    );

  const merged = [...waitingBase];
  const hasEntry = (candidate = {}) => {
    const cUid = String(candidate.uid || "").trim();
    const cEmail = String(candidate.email || "").trim();
    const cName = String(candidate.name || "").trim();
    return merged.some((w) => {
      const wUid = String(w?.uid || "").trim();
      const wEmail = String(w?.email || "").trim();
      const wName = String(w?.name || "").trim();
      if (cUid && wUid && cUid === wUid) return true;
      if (cEmail && wEmail && cEmail === wEmail) return true;
      if (!cUid && !cEmail && cName && wName === cName) return true;
      return false;
    });
  };

  GL.attendanceWaiting.forEach((item) => {
    const uid = String(item?.uid || "").trim();
    if (
      isPersonSeatedInGlobalSeats(GL.globalSeats, {
        uid,
        email: item?.email,
        name: item?.nickname || item?.name
      })
    ) {
      return;
    }
    if (hasEntry(item)) return;
    merged.push({
      id: String(item.id || `att_${uid || makeUid("att")}`),
      uid,
      email: String(item.email || "").trim(),
      name: String(item.name || item.nickname || "").trim() || uid || "-",
      tournamentId: GL.tournamentId,
      joinedAt: Number(item.statusChangedAt || item.checkedInAt || Date.now()) || Date.now(),
      source: "attendance_fallback"
    });
  });

  return merged;
}
