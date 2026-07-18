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

  currentTournament: null,
  globalSeats: [],
  globalWaiting: [],
  /** realtime 스냅샷마다 증가 — getCurrentTournamentWaiting 캐시 무효화 */
  dataRevision: 0,
  /** 배치·비우기 동시 클릭 방지 */
  seatMutationInFlight: false,
  /** 대기 추가·삭제·BLOCK 중 realtime 덮어쓰기 방지 */
  waitingMutationInFlight: false,
  /** 로컬 변경 후 캐시 스냅샷 무시 시각(unix ms) */
  localMutationUntil: 0,
  /** admin 좌석 삭제 직후 자동 대기 복구 억제 시각(unix ms) */
  skipSeatRecoveryUntil: 0,
  /**
   * 방금 생성 요청을 보냈지만 아직 setDoc 이 끝나지 않은 seatId 모음.
   * realtime 스냅샷 병합(mergeGlobalSeatsFromSnapshot)에서, 이 목록에 있는 좌석은
   * 시간 기준 유예(RECENT_LOCAL_SEAT_MS)가 지났더라도 스냅샷에 아직 없다는 이유로
   * 지우지 않는다 — 네트워크가 느려 12초 안에 저장이 안 끝나면 캔버스에서
   * 좌석이 사라지는 문제를 막기 위함.
   */
  pendingLocalSeatIds: new Set(),
  attendanceWaiting: [],
  /** uid → dealer_attendance — 스왑·비우기 시 원래 joinedAt 복원용 */
  attendanceByUid: new Map(),
  /** 현재 대회 출석 문서 기준 퇴근·미출근 uid — global_waiting 유령 행 제거용 */
  attendanceInactiveUids: new Set(),
  attendanceCheckedOutUids: new Set(),
  /** dealer_attendance 1회 이상 반영 전에는 global_waiting 유령 행 숨김 */
  attendanceFilterReady: false,
  /** BLOCK 저장 확인 전까지 스냅샷·heal 이 덮어쓰지 못하게 하는 로컬 잠금 */
  pendingWaitingBlockByPerson: new Map(),

  selectedWaitingId: "",
  /** 다중 선택: Ctrl(Windows/Linux) 또는 ⌘(macOS) + 클릭으로 토글 */
  selectedSeatIds: new Set(),

  isAdminUser: false,
  /** ensureGlobalLayoutOpsChrome 서버 통과 — 캐시만으로 ops UI 내리지 않음 */
  opsServerVerified: false,
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
  /** 되돌린 작업 redo stack (최신이 끝, 최대 undo 와 동일) */
  globalRedoStack: [],
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
