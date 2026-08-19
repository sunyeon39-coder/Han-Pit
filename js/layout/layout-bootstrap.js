/**
 * layout.html: 원격 상태 로드·부트 저장·실시간 구독·첫 렌더
 */
export function createLayoutBootstrap(deps) {
  const {
    EVENT_ID,
    BOX_ID,
    FOCUS_SEAT_ID,
    refreshCachedEventCardTitle,
    loadEventStateRemote,
    loadEventStateFromGlobalSeats,
    loadWaitingStateRemote,
    eventState,
    waitingState,
    isEmptyPerson,
    normalizeWaitingEntry,
    getIsAdminUser,
    saveEventState,
    saveWaitingState,
    layoutHealUndo,
    layoutViewport,
    layoutGlobalSeatsMerge,
    layoutRealtime,
    render,
    startTick,
    seatNotify,
    scheduleLayoutRealtimeUi
  } = deps;

  let hasInitialized = false;

  async function init() {
    if (hasInitialized) return;
    hasInitialized = true;

    const [remoteEvent, remoteWaiting] = await Promise.all([
      refreshCachedEventCardTitle(),
      loadEventStateRemote(),
      loadWaitingStateRemote()
    ]);
    const hasRemoteSeats =
      remoteEvent &&
      typeof remoteEvent === "object" &&
      Array.isArray(remoteEvent.seats) &&
      remoteEvent.seats.length > 0;
    const fallbackEvent = hasRemoteSeats ? null : await loadEventStateFromGlobalSeats();
    const initialEvent = remoteEvent && typeof remoteEvent === "object" ? remoteEvent : fallbackEvent;

    if (initialEvent && typeof initialEvent === "object") {
      eventState.version = initialEvent.version || 2;
      eventState.eventId = initialEvent.eventId || EVENT_ID;
      eventState.boxId = initialEvent.boxId || BOX_ID;
      eventState.nextSeatNo = initialEvent.nextSeatNo || 1;
      eventState.nextSeatOrder = initialEvent.nextSeatOrder || 1;
      eventState.seats = Array.isArray(initialEvent.seats) ? initialEvent.seats : [];
      eventState.updatedAt = Number(initialEvent.updatedAt || Date.now());
    }

    if (remoteWaiting && typeof remoteWaiting === "object") {
      waitingState.version = remoteWaiting.version || 2;
      waitingState.waiting = Array.isArray(remoteWaiting.waiting) ? remoteWaiting.waiting : [];
      waitingState.updatedAt = Number(remoteWaiting.updatedAt || Date.now());
      waitingState.__serverRows = waitingState.waiting.map((r) => ({ ...r }));
    }

    waitingState.waiting.forEach((w) => {
      if (!("uid" in w)) w.uid = "";
      if (!("email" in w)) w.email = "";
    });

    eventState.seats.forEach((s) => {
      if (!isEmptyPerson(s.person) && !s.seatedAt) s.seatedAt = Date.now();
      if (isEmptyPerson(s.person)) s.seatedAt = null;
      if (s.label == null) s.label = String(s.no ?? "");
      if (!("personUid" in s)) s.personUid = "";
      if (!("personEmail" in s)) s.personEmail = "";
    });

    layoutViewport.loadCanvasViewFromStorage();

    layoutGlobalSeatsMerge.bindTournamentGlobalSeatsMerge();
    layoutGlobalSeatsMerge.applyGlobalSeatMapToEventSeats();

    layoutRealtime.bindRealtime();
    render();
    startTick();

    seatNotify.maybePromptInitialSound({ isAdminUser: getIsAdminUser() });

    void (async () => {
      const bootSaves = [];
      // layout_events 는 Rules 상 관리자만 쓰기 가능 — 비관리자는 빈 문서 생성 시도 시 permission 오류
      if (!remoteEvent && getIsAdminUser()) bootSaves.push(saveEventState());
      if (!remoteWaiting) bootSaves.push(saveWaitingState());
      if (bootSaves.length) await Promise.all(bootSaves);

      waitingState.waiting = waitingState.waiting
        .map((w) => normalizeWaitingEntry(w))
        .filter(Boolean);

      await layoutHealUndo.healAndPersistState("init");
      if (scheduleLayoutRealtimeUi) {
        scheduleLayoutRealtimeUi({ canvas: true, panel: true });
      } else {
        render();
      }
    })();

    if (FOCUS_SEAT_ID) {
      sessionStorage.removeItem("focusSeatId");
    }
  }

  return { init };
}
