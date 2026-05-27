/** Shared DOM refs and mutable index page state */
export const IX = {
  root: null,
  backBtn: null,
  topbarTournamentName: null,

  eventAdminBtn: null,
  globalLayoutBtn: null,
  attendanceLogBtn: null,
  attendanceLogModal: null,
  closeAttendanceLogBtn: null,
  attendanceLogSearch: null,
  attendanceLogActionFilter: null,
  attendanceLogSummary: null,
  attendanceLogList: null,
  clearAttendanceLogsBtn: null,
  deleteSelectedAttendanceLogsBtn: null,

  seatMapOpenEditorBtn: null,
  eventAdminModal: null,
  closeEventAdminBtn: null,

  eventCardSelect: null,
  eventCardId: null,
  eventCardBoxId: null,
  eventCardDate: null,
  eventCardTitle: null,
  eventCardStart: null,
  eventCardClose: null,

  newEventCardBtn: null,
  saveEventCardBtn: null,
  deleteEventCardBtn: null,
  eventCardList: null,
  dealerOpsMount: null,

  enablePushBtn: null,
  seatMapBtn: null,
  seatMapModal: null,
  seatMapCloseBtn: null,
  seatMapEditActions: null,
  seatMapCanvas: null,
  seatMapScroll: null,

  addSeatBtn: null,
  deleteSeatMapBtn: null,
  alignSeatMapRowBtn: null,
  alignSeatMapColBtn: null,
  saveMapBtn: null,

  stopDealerAttendanceWatch: null,
  stopDealerSeatWatch: null,
  stopAttendanceLogsWatch: null,
  attendanceLogEventsBound: false,

  attendanceLogUi: {
    search: "",
    action: "all",
    selectedIds: new Set()
  },

  attendanceLogs: [],

  dealerAttendanceMap: new Map(),
  dealerSeatMap: new Map(),

  dealerAdminUi: {
    search: "",
    status: "all",
    sort: "name"
  },

  dealerOpsRenderTimer: null,

  events: [],
  currentTournament: null,
  currentUserProfile: null,
  currentSeatAssignment: null,
  seatSummaryMap: new Map(),
  dealerUiCollapsed: true,

  stopTournamentWatch: null,
  stopMySeatNotificationWatch: null,
  stopEventsWatch: null,
  stopLayoutEventsWatch: null,
  periodBlocked: false,

  seatMapLayout: [],
  seatMapData: new Map(),
  editorSeats: []
};

/** index.html 의 DOM 이 준비된 뒤에도 다시 호출해 IX.* 참조를 갱신합니다. */
export function refreshIndexDomRefs() {
  const $ = (id) => document.getElementById(id);

  IX.root = $("indexRoot");
  IX.backBtn = $("backBtn");
  IX.topbarTournamentName = $("topbarTournamentName");

  IX.eventAdminBtn = $("eventAdminBtn");
  IX.globalLayoutBtn = $("globalLayoutBtn");
  IX.attendanceLogBtn = $("attendanceLogBtn");
  IX.attendanceLogModal = $("attendanceLogModal");
  IX.closeAttendanceLogBtn = $("closeAttendanceLogBtn");
  IX.attendanceLogSearch = $("attendanceLogSearch");
  IX.attendanceLogActionFilter = $("attendanceLogActionFilter");
  IX.attendanceLogSummary = $("attendanceLogSummary");
  IX.attendanceLogList = $("attendanceLogList");
  IX.clearAttendanceLogsBtn = $("clearAttendanceLogsBtn");
  IX.deleteSelectedAttendanceLogsBtn = $("deleteSelectedAttendanceLogsBtn");

  IX.seatMapOpenEditorBtn = $("seatMapOpenEditorBtn");
  IX.eventAdminModal = $("eventAdminModal");
  IX.closeEventAdminBtn = $("closeEventAdminBtn");

  IX.eventCardSelect = $("eventCardSelect");
  IX.eventCardId = $("eventCardId");
  IX.eventCardBoxId = $("eventCardBoxId");
  IX.eventCardDate = $("eventCardDate");
  IX.eventCardTitle = $("eventCardTitle");
  IX.eventCardStart = $("eventCardStart");
  IX.eventCardClose = $("eventCardClose");

  IX.newEventCardBtn = $("newEventCardBtn");
  IX.saveEventCardBtn = $("saveEventCardBtn");
  IX.deleteEventCardBtn = $("deleteEventCardBtn");
  IX.eventCardList = $("eventCardList");
  IX.dealerOpsMount = $("dealerOpsMount");

  IX.enablePushBtn = $("enablePushBtn");
  IX.seatMapBtn = $("seatMapBtn");
  IX.seatMapModal = $("seatMapModal");
  IX.seatMapCloseBtn = $("seatMapCloseBtn");
  IX.seatMapEditActions = $("seatMapEditActions");
  IX.seatMapCanvas = $("seatMapCanvas");
  IX.seatMapScroll = $("seatMapScroll");

  IX.addSeatBtn = $("addSeatBtn");
  IX.deleteSeatMapBtn = $("deleteSeatMapBtn");
  IX.alignSeatMapRowBtn = $("alignSeatMapRowBtn");
  IX.alignSeatMapColBtn = $("alignSeatMapColBtn");
  IX.saveMapBtn = $("saveMapBtn");
}
