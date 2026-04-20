/**
 * layout.html: 패널 time-chip + PC Seat 박스 경과 시간 표시/색상 클래스
 */
export function createLayoutUpdateTimers(deps) {
  const { eventState, isEmptyPerson, timerClass, fmtElapsed } = deps;

  function updateTimers() {
    const now = Date.now();

    document.querySelectorAll(".time-chip[data-start][data-timer]").forEach((chip) => {
      const start = Number(chip.dataset.start || 0);
      if (!start) return;

      const ms = now - start;
      chip.textContent = fmtElapsed(ms);

      const cls = timerClass(ms);
      chip.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      chip.classList.add(cls);
    });

    document.querySelectorAll(".seat-box[data-seatid]").forEach((box) => {
      const id = box.dataset.seatid;
      const seat = eventState.seats.find((s) => s.id === id);

      if (!seat || isEmptyPerson(seat.person) || !seat.seatedAt) {
        box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
        return;
      }

      const ms = now - seat.seatedAt;
      const cls = timerClass(ms);
      box.classList.remove("t-green", "t-yellow", "t-orange", "t-red");
      box.classList.add(cls);
    });
  }

  return { updateTimers };
}
