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
  assignedCountEl: null,
  waitingCountEl: null,
  blockedCountEl: null,
  pcPanel: null,
  panelContent: null,
  tabs: [],
  mobileSheet: null,
  mobileAddSeatBtn: null,
  mobileAddWaitingBtn: null,

  stopSeatWatch: null,
  stopWaitingWatch: null,
  stopAttendanceWatch: null,

  globalSeats: [],
  globalWaiting: [],
  /** realtime 스냅샷마다 증가 — getCurrentTournamentWaiting 캐시 무효화 */
  dataRevision: 0,
  /** 배치·비우기 동시 클릭 방지 */
  seatMutationInFlight: false,
  attendanceWaiting: [],
  /** 현재 대회 출석 문서 기준 퇴근·미출근 uid — global_waiting 유령 행 제거용 */
  attendanceInactiveUids: new Set(),
  /** dealer_attendance 1회 이상 반영 전에는 global_waiting 유령 행 숨김 */
  attendanceFilterReady: false,

  selectedWaitingId: "",
  /** 다중 선택: Ctrl(Windows/Linux) 또는 ⌘(macOS) + 클릭으로 토글 */
  selectedSeatIds: new Set(),

  isAdminUser: false,
  currentUser: null,
  /** users.layoutAccentColor — 직접 허용 시 Hub에서 부여 */
  layoutAccentColor: "#4DA3FF",
  /** layout_shared/global_waiting.operatorPicks */
  operatorPicks: {},
  /** 본인 좌석 강조용 (users 프로필 스냅샷) */
  userProfile: null,
  hasShownPermissionAlert: false,

  activeTab: "wait",
  dragState: null,
  suppressSeatClickUntil: 0,
  seatSortMode: "seat",
  timerHandle: null,
  panelOpen: false,
  /** 최근 작업 undo stack (최신이 끝) */
  globalUndoStack: [],
  /** 하위 호환용 최신 undo 1건 캐시 */
  lastGlobalUndo: null,
  waitListScrollTop: 0,
  seatListScrollTop: 0,
  /** 모바일 카드 목록 스크롤 (전체 re-render 시 복원) */
  mobileListScrollTop: 0,
  lastSeatTapAt: 0,
  lastSeatTapId: "",

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
  GL.assignedCountEl = document.getElementById("assignedCount");
  GL.waitingCountEl = document.getElementById("waitingCount");
  GL.blockedCountEl = document.getElementById("blockedCount");
  GL.pcPanel = document.getElementById("pcPanel");
  GL.panelContent = document.getElementById("panelContent");
  GL.tabs = Array.from(document.querySelectorAll(".tab"));
  GL.mobileSheet = document.getElementById("mobileSheet");
  GL.mobileAddSeatBtn = document.getElementById("mobileAddSeat");
  GL.mobileAddWaitingBtn = document.getElementById("mobileAddWaiting");
}
