/** Hub 페이지 전역 가변 상태 (단일 엔트리 모듈에서 갱신) */
export const FALLBACK_TOURNAMENTS = [
  {
    id: "ept-paris-2026",
    name: "EPT Paris 2026",
    startDate: "26-02-18",
    endDate: "26-03-01",
    logoText: "EPT",
    requiredCode: "EPT2026A"
  }
];

export const hubState = {
  currentUser: null,
  currentUserProfile: null,
  tournamentsCache: [],
  usersCache: [],
  selectedManageUid: null,
  /** 접근 허용 관리 — 유저 목록 일괄 선택 (uid) */
  adminBulkSelectedUids: new Set(),
  stopTournamentsWatch: null,
  stopUsersWatch: null,
  stopMyProfileWatch: null,
  /** `bindMyProfileRealtime`가 현재 uid에 대해 구독 중이면 true — onAuth 중복 시 stale 덮어쓰기 방지 */
  hubProfileWatchUid: null,
  /** onAuthStateChanged 비동기 경합 시 오래된 완료분 무시 */
  hubAuthFlowGen: 0,
  adminActionInFlight: false,
  usersRoleHealDone: false,
  usersRoleHealInFlight: false,
  /** false 인 동안 목록이 비어 있으면 "대회 없음" 대신 로딩 유지 */
  tournamentsBootstrapping: true,
  /** Firestore 1회 이상 반영 후에만 빈 목록 UI 허용 */
  tournamentsListReady: false
};
