import { IX, refreshIndexDomRefs } from "./state.js";

let indexOpsVerified = false;
let indexHadOps = false;

export function getIndexHadOps() {
  return indexHadOps;
}

export function isIndexOpsChromeVerified() {
  return indexOpsVerified;
}

export function resetIndexOpsChromeState() {
  indexOpsVerified = false;
  indexHadOps = false;
}

/** 운영 UI(통합배치도·카드관리 등) 툴바 표시 — 딜러 운영 패널과 동기화 */
export function syncIndexOpsToolbar(canOps) {
  refreshIndexDomRefs();
  indexHadOps = canOps === true;

  if (canOps) {
    indexOpsVerified = true;
    IX.globalLayoutBtn?.classList.remove("hidden");
    IX.seatMapOpenEditorBtn?.classList.remove("hidden");
    IX.eventAdminBtn?.classList.remove("hidden");
    IX.attendanceLogBtn?.classList.remove("hidden");
    IX.payrollTableBtn?.classList.remove("hidden");
    if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "1";
    return;
  }

  if (indexOpsVerified) return;

  IX.globalLayoutBtn?.classList.add("hidden");
  IX.seatMapOpenEditorBtn?.classList.add("hidden");
  IX.eventAdminBtn?.classList.add("hidden");
  IX.attendanceLogBtn?.classList.add("hidden");
  IX.payrollTableBtn?.classList.add("hidden");
  if (IX.seatMapOpenEditorBtn) IX.seatMapOpenEditorBtn.dataset.canEdit = "0";
}
