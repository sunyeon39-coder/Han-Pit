/**
 * 통합 배치도 화면 공유 상태 (단일 객체로 유지 → 모듈 간 순환 의존 최소화)
 */
export const GL = {
  tournamentId: "",
  urlEventId: "",
  urlBoxId: "",

  app: null,
  menuBtn: null,
  enablePushBtn: null,
  backBtn: null,
  canvasZoomBar: null,
  seatCountEl: null,
  waitingCountEl: null,
  pcPanel: null,
  panelContent: null,
  tabs: [],

  stopSeatWatch: null,
  stopWaitingWatch: null,
  stopAttendanceWatch: null,

  globalSeats: [],
  globalWaiting: [],
  attendanceWaiting: [],

  selectedWaitingId: "",
  /** 다중 선택: Ctrl(Windows/Linux) 또는 ⌘(macOS) + 클릭으로 토글 */
  selectedSeatIds: new Set(),

  isAdminUser: false,
  hasShownPermissionAlert: false,

  activeTab: "wait",
  dragState: null,
  suppressSeatClickUntil: 0,
  seatSortMode: "seat",
  timerHandle: null,
  panelOpen: false,
  lastGlobalUndo: null,
  waitListScrollTop: 0,
  seatListScrollTop: 0,

  /** PC 캔버스 패닝·줌 (우측 패널에 가린 영역 탐색) */
  canvasPanX: 0,
  canvasPanY: 0,
  canvasZoom: 1
};

export function initGlFromUrl() {
  const params = new URLSearchParams(location.search);
  GL.tournamentId = params.get("tournamentId") || sessionStorage.getItem("tournamentId") || "";
  GL.urlEventId = String(params.get("eventId") || "").trim();
  GL.urlBoxId = String(params.get("boxId") || "").trim();
}

export function initGlDomRefs() {
  GL.app = document.getElementById("app");
  GL.menuBtn = document.getElementById("menuBtn");
  GL.enablePushBtn = document.getElementById("enablePushBtn");
  GL.backBtn = document.getElementById("backBtn");
  GL.canvasZoomBar = document.getElementById("canvasZoomBar");
  GL.seatCountEl = document.getElementById("seatCount");
  GL.waitingCountEl = document.getElementById("waitingCount");
  GL.pcPanel = document.getElementById("pcPanel");
  GL.panelContent = document.getElementById("panelContent");
  GL.tabs = Array.from(document.querySelectorAll(".tab"));
}
