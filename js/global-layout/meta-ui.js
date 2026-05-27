import { GL } from "./state.js";
import { isEmptyPerson } from "./utils.js";

export function updateGlobalLayoutMetaCounts(seats = []) {
  const list = Array.isArray(seats) ? seats : [];
  if (GL.seatCountEl) GL.seatCountEl.textContent = `SEAT: ${list.length}`;
  if (GL.assignedCountEl) {
    const assignedCount = list.filter((s) => !isEmptyPerson(String(s?.person || "").trim())).length;
    GL.assignedCountEl.textContent = `ASSIGNED: ${assignedCount}`;
  }
}
