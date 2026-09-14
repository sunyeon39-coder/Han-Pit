import { auth } from "../firebase.js";
import { layoutIsMobile } from "../layout/layout-main-route-env.js";
import { GL } from "./state.js";
import {
  escapeHtml,
  isEmptyPerson,
  seatCanvasDigitsOnly,
  getGlobalSeatRowKey,
  getSeatConfirmHighlightState,
  toMillis
} from "./utils.js";
import { syncSelectedWaitingFromMyOperatorPick } from "./waiting-picks.js";
import { waitingRowBelongsToTournament } from "./waiting.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import { resolveSeatEventBox } from "./utils.js";
import { openGlobalMobileSeatAddModal } from "./mobile-seat-add-modal.js";
import {
  updateGlobalLayoutMetaCounts,
  updateGlobalLayoutWaitingMeta,
  syncGlobalLayoutMetaPills
} from "./meta-ui.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";
import { tryOpenSeatHistoryFromPersonClick } from "./seat-history-modal.js";
import { isActiveAttendanceStatus } from "../shared/attendance-operational-day.js";

function resolveMobileSeatCardId(seat = {}) {
  const { eventId } = resolveSeatEventBox(seat);
  if (!eventId) return "";
  return getEventCardIdFromRecord({ id: eventId }) || eventId;
}

/** 닉네임 조회(Seat 카드 상단) — Seat 위에서 자신의 닉네임으로 현재 배치를 찾는 검색창 */
let mobileDealerLookupQuery = "";

function findDealerByNickname(query = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  const roster = getActiveDealerRosterForMobile();
  return (
    roster.find((d) => String(d.name || "").trim().toLowerCase() === q) ||
    roster.find((d) => String(d.name || "").trim().toLowerCase().includes(q)) ||
    null
  );
}

function buildDealerLookupResultHtml(query = "") {
  const q = String(query || "").trim();
  if (!q) {
    return `
      <div class="mobile-lookup-hint">닉네임을 입력하세요.</div>
      <div class="mobile-lookup-placeholder">닉네임을 입력하면 현재·다음의 배치를 표시합니다</div>
      <div class="mobile-lookup-placeholder">다음 배치가 여기에 표시됩니다.</div>
    `;
  }

  const dealer = findDealerByNickname(q);
  const currentSeat = dealer ? resolveDealerCurrentSeat(dealer) : null;
  const nextSeat = dealer ? resolveDealerNextSeat(dealer) : null;
  const buildSeatText = (seat) =>
    `${escapeHtml(resolveMobileSeatCardId(seat) || "-")} · Seat ${escapeHtml(seatCanvasDigitsOnly(seat.label, seat.no))}`;

  return `
    <div class="mobile-lookup-hint mobile-lookup-hint--result">${escapeHtml(q)}</div>
    <div class="mobile-lookup-section">
      <div class="mobile-lookup-section-label">CURRENT <span>| 현재 배치</span></div>
      <div class="mobile-lookup-row">
        <span class="mobile-lookup-dash">${currentSeat ? "" : "—"}</span>
        <span>${currentSeat ? buildSeatText(currentSeat) : "현재 배치가 없습니다."}</span>
      </div>
    </div>
    <div class="mobile-lookup-section">
      <div class="mobile-lookup-section-label">NEXT <span>| 다음 배치</span></div>
      <div class="mobile-lookup-row">
        <span class="mobile-lookup-dash">${nextSeat ? "" : "—"}</span>
        <span>${nextSeat ? buildSeatText(nextSeat) : "다음 배치가 없습니다."}</span>
      </div>
    </div>
  `;
}

function buildDealerLookupCardHtml() {
  return `
    <div class="mobile-lookup-field">
      <label for="globalMobileLookupInput">닉네임 검색</label>
      <input id="globalMobileLookupInput" type="text" placeholder="예: 홍길동" autocomplete="off" value="${escapeHtml(mobileDealerLookupQuery)}" />
    </div>
    <div id="globalMobileLookupResult">${buildDealerLookupResultHtml(mobileDealerLookupQuery)}</div>
  `;
}

let firestoreOpsPromise = null;
function loadFirestoreOps() {
  if (!firestoreOpsPromise) {
    firestoreOpsPromise = import("./firestore-ops.js");
  }
  return firestoreOpsPromise;
}

const GLOBAL_MOBILE_SEAT_DOUBLE_MS = 350;

/** 계정(출근) 없이 수동으로 추가한 테스트/임시 딜러 — global_waiting 에만 존재, uid 없음 */
function getManualWaitingRosterForMobile() {
  const tid = String(GL.tournamentId || "").trim();
  return (GL.globalWaiting || [])
    .filter((w) => !String(w?.uid || "").trim())
    .filter((w) => waitingRowBelongsToTournament(w, tid))
    .map((w) => ({
      uid: "",
      waitingId: String(w.id || "").trim(),
      name: String(w.name || "-").trim() || "-",
      sinceMs: Number(w.joinedAt || w.createdAt || 0) || 0,
      isManualWaiting: true
    }));
}

/**
 * uid 없이(수동 추가) 배치된 딜러 — 배치되는 순간 global_waiting 문서는 지워지므로
 * 이 목록에서 안 챙기면 좌석에 앉은 채로 명단에서 사라져 보인다.
 */
function getSeatedManualDealersForMobile() {
  return (GL.globalSeats || [])
    .filter((s) => !isEmptyPerson(String(s?.person || "").trim()) && !String(s?.personUid || "").trim())
    .map((s) => ({
      uid: "",
      waitingId: `seat_${String(s.seatId || "").trim()}`,
      name: String(s.person || "").trim(),
      sinceMs: Number(s.seatedAt || 0) || 0
    }));
}

/** 딜러 명단(Seat 카드 대체) — 출근(대기 이상 active 상태)한 딜러 + 수동 추가/배치된 딜러, 오래된 순 */
function getActiveDealerRosterForMobile() {
  const rows = [];
  (GL.attendanceByUid || new Map()).forEach((att, uid) => {
    if (!isActiveAttendanceStatus(att?.status)) return;
    rows.push({
      uid: String(uid || "").trim(),
      name: String(att?.nickname || att?.name || uid || "-").trim() || "-",
      sinceMs: Number(att?.statusChangedAt || att?.checkedInAt || 0) || 0
    });
  });

  const seatedManualNames = new Set();
  const seatedManual = getSeatedManualDealersForMobile();
  seatedManual.forEach((d) => seatedManualNames.add(d.name));
  rows.push(...seatedManual);

  // 배치되며 대기 문서가 지워지기 전 짧은 타이밍에 스냅샷이 겹치는 경우 중복 방지
  rows.push(...getManualWaitingRosterForMobile().filter((d) => !seatedManualNames.has(d.name)));

  rows.sort((a, b) => a.sinceMs - b.sinceMs);
  return rows;
}

function seatMatchesPerson(s, dealer) {
  const uid = String(dealer?.uid || "").trim();
  const name = String(dealer?.name || "").trim();
  const person = String(s?.person || "").trim();
  if (isEmptyPerson(person)) return false;
  const personUid = String(s?.personUid || "").trim();
  if (uid && personUid) return personUid === uid;
  return !uid && !personUid && person === name;
}

function seatMatchesPreviousPerson(s, dealer) {
  const uid = String(dealer?.uid || "").trim();
  const name = String(dealer?.name || "").trim();
  const prevPerson = String(s?.previousPerson || "").trim();
  if (isEmptyPerson(prevPerson)) return false;
  const prevUid = String(s?.previousPersonUid || "").trim();
  if (uid && prevUid) return prevUid === uid;
  return !uid && !prevUid && prevPerson === name;
}

/**
 * 다음(NEXT) — 배치확인으로 방금 이 좌석의 실제 occupant가 된 딜러, 전환 구간(확정 후 10분)에만.
 * 현재(CURRENT) — 전환 중이면 스왑으로 밀려난 이전 occupant 의 좌석을 그대로 보여주고,
 * 전환이 끝났거나 애초에 스왑이 아니었으면 실제 occupant 좌석을 보여준다.
 * admin은 확정 즉시(0분부터) 다음 배치를 볼 수 있지만, 근무자는 공개 시점(REVEAL, 5분)
 * 전까지는 교대 사실 자체를 알 수 없어야 한다.
 */
function resolveDealerNextSeat(dealer = {}) {
  const seat = (GL.globalSeats || []).find((s) => seatMatchesPerson(s, dealer));
  if (!seat) return null;
  const { isRecent, isBlinkPhase } = getSeatConfirmHighlightState(toMillis(seat.seatedAt));
  if (!isRecent) return null;
  if (!canManageGlobalLayoutOps() && !isBlinkPhase) return null;
  return seat;
}

function resolveDealerCurrentSeat(dealer = {}) {
  const prevSeat = (GL.globalSeats || []).find((s) => {
    // 좌석이 지금 실제로 비어 있으면 "스왑 전환 중"일 수 없다 — previousPerson 필드가
    // (예: 비우기 직후 한 틱 정도) 남아있어도 여기서 절대 걸리지 않게 방어한다.
    if (isEmptyPerson(String(s?.person || "").trim())) return false;
    if (!seatMatchesPreviousPerson(s, dealer)) return false;
    return getSeatConfirmHighlightState(toMillis(s.seatedAt)).isRecent;
  });
  if (prevSeat) return prevSeat;

  const seat = (GL.globalSeats || []).find((s) => seatMatchesPerson(s, dealer));
  if (!seat) return null;
  return getSeatConfirmHighlightState(toMillis(seat.seatedAt)).isRecent ? null : seat;
}

function resolveDealerCurrentSeatLabel(dealer = {}) {
  const seat = resolveDealerCurrentSeat(dealer);
  return seat ? seatCanvasDigitsOnly(seat.label, seat.no) : "";
}

function setMobileSeatSelection(seatId = "") {
  const sid = String(seatId || "").trim();
  GL.selectedSeatIds.clear();
  if (sid) GL.selectedSeatIds.add(sid);
}

function getGlobalLayoutMobileScrollEl() {
  return GL.app?.querySelector(".global-layout-mobile") || null;
}

function captureGlobalLayoutMobileScroll() {
  const el = getGlobalLayoutMobileScrollEl();
  GL.mobileListScrollTop = el ? el.scrollTop : 0;
}

function restoreGlobalLayoutMobileScroll() {
  const top = Number(GL.mobileListScrollTop) || 0;
  const apply = () => {
    const el = getGlobalLayoutMobileScrollEl();
    if (el) el.scrollTop = top;
  };
  apply();
  requestAnimationFrame(apply);
}

function mobileLayoutStructureFingerprint() {
  return getActiveDealerRosterForMobile()
    .map((d) => {
      const cur = resolveDealerCurrentSeat(d);
      const next = resolveDealerNextSeat(d);
      const curLabel = cur ? seatCanvasDigitsOnly(cur.label, cur.no) : "";
      const nextLabel = next ? seatCanvasDigitsOnly(next.label, next.no) : "";
      return `${d.uid || d.waitingId}:${curLabel}:${nextLabel}`;
    })
    .join(",");
}

function trySyncGlobalLayoutMobile() {
  const root = getGlobalLayoutMobileScrollEl();
  if (!root) return false;

  const nextFp = mobileLayoutStructureFingerprint();
  if (root.getAttribute("data-mobile-structure-fp") !== nextFp) return false;

  captureGlobalLayoutMobileScroll();
  updateGlobalLayoutMetaCounts(GL.globalSeats);
  syncGlobalLayoutMetaPills(root);
  updateGlobalLayoutWaitingMeta();

  restoreGlobalLayoutMobileScroll();
  return true;
}

let mobileEventsWired = false;

export function wireGlobalLayoutMobileEventsOnce() {
  if (mobileEventsWired || !GL.app) return;
  mobileEventsWired = true;

  const fullRender = () => renderGlobalLayoutMobile({ forceFull: true });

  GL.app.addEventListener("click", async (e) => {
    if (!layoutIsMobile()) return;

    if (e.target.closest("#globalMobileAddSeatInline")) {
      void openGlobalMobileSeatAddModal();
      return;
    }

    if (e.target.closest("#globalMobileAddManualDealerInline")) {
      const name = prompt("딜러 이름(테스트용)", "");
      if (name === null) return;
      try {
        const { addManualWaitingByName } = await loadFirestoreOps();
        await addManualWaitingByName(name);
        fullRender();
      } catch (err) {
        console.error("addManualWaitingByName error:", err);
        alert("딜러 추가에 실패했습니다.");
      }
      return;
    }

    const delManualBtn = e.target.closest("[data-del-manual-waiting]");
    if (delManualBtn) {
      e.stopPropagation();
      const wid = String(delManualBtn.getAttribute("data-del-manual-waiting") || "").trim();
      if (!wid || !confirm("이 딜러를 삭제하시겠습니까?")) return;
      try {
        const { removeManualWaiting } = await loadFirestoreOps();
        await removeManualWaiting(wid);
        fullRender();
      } catch (err) {
        console.error("removeManualWaiting error:", err);
        alert("삭제에 실패했습니다.");
      }
      return;
    }

    const moreBtn = e.target.closest("[data-seat-more]");
    if (moreBtn) {
      e.stopPropagation();
      const actions = moreBtn.closest("[data-mobile-seat]")?.querySelector(".mobile-seat-actions-row");
      if (actions) actions.hidden = !actions.hidden;
      return;
    }

    const assignBtn = e.target.closest("[data-mobile-assign]");
    if (assignBtn) {
      e.stopPropagation();
      syncSelectedWaitingFromMyOperatorPick();
      const sid = String(assignBtn.getAttribute("data-mobile-assign") || "").trim();
      if (!String(GL.selectedWaitingId || "").trim() || !sid) return;
      try {
        const { assignSelectedWaitingToSeat } = await loadFirestoreOps();
        await assignSelectedWaitingToSeat(sid);
        fullRender();
      } catch (err) {
        console.error("mobile assign button error:", err);
        alert("대기 배치에 실패했습니다.");
        fullRender();
      }
      return;
    }

    const delSeatBtn = e.target.closest("[data-del-seat]");
    if (delSeatBtn) {
      e.stopPropagation();
      const sid = String(delSeatBtn.getAttribute("data-del-seat") || "").trim();
      const docId = String(delSeatBtn.getAttribute("data-del-doc") || "").trim();
      if ((!sid && !docId) || !confirm("이 좌석을 삭제하시겠습니까?")) return;
      try {
        const { deleteGlobalSeat } = await loadFirestoreOps();
        await deleteGlobalSeat(sid, { firestoreDocId: docId });
        if (sid) GL.selectedSeatIds.delete(sid);
      } catch (err) {
        console.error("mobile deleteGlobalSeat error:", err);
        alert("좌석 삭제에 실패했습니다.");
      }
      fullRender();
      return;
    }

    const clearBtn = e.target.closest("[data-clear-seat]");
    if (clearBtn) {
      e.stopPropagation();
      const sid = String(clearBtn.getAttribute("data-clear-seat") || "").trim();
      if (!sid) return;
      try {
        const { clearSeat } = await loadFirestoreOps();
        await clearSeat(sid);
      } catch (err) {
        console.error("mobile clearSeat error:", err);
        fullRender();
      }
      return;
    }

    const renameBtn = e.target.closest("[data-rename-seat]");
    if (renameBtn) {
      e.stopPropagation();
      const sid = String(renameBtn.getAttribute("data-rename-seat") || "").trim();
      if (!sid) return;
      const { openSeatEditModal } = await import("./seat-edit-modal.js");
      openSeatEditModal(sid);
      return;
    }

    const seatRow = e.target.closest("[data-mobile-seat]");
    if (
      seatRow &&
      !e.target.closest("[data-del-seat]") &&
      !e.target.closest("[data-mobile-assign]") &&
      !e.target.closest("[data-clear-seat]") &&
      !e.target.closest("[data-rename-seat]") &&
      !e.target.closest("[data-seat-more]") &&
      !e.target.closest(".mobile-seat-actions-row")
    ) {
      const sid = String(seatRow.getAttribute("data-mobile-seat") || "").trim();
      if (!sid) return;
      if (tryOpenSeatHistoryFromPersonClick(e, sid)) return;
      const seat = GL.globalSeats.find((x) => getGlobalSeatRowKey(x) === sid || String(x.seatId || "").trim() === sid);
      const occupied = seat && !isEmptyPerson(String(seat.person || "").trim());
      const now = Date.now();

      if (GL.selectedWaitingId) {
        syncSelectedWaitingFromMyOperatorPick();
        if (!String(GL.selectedWaitingId || "").trim()) {
          fullRender();
          return;
        }
        setMobileSeatSelection(sid);
        try {
          const { assignSelectedWaitingToSeat } = await loadFirestoreOps();
          await assignSelectedWaitingToSeat(sid);
          fullRender();
        } catch (err) {
          if (String(err?.message || "").includes("same_person_noop")) {
            alert("이미 이 Seat에 있는 사람입니다. 다른 Seat를 선택하세요.");
          } else if (String(err?.message || "").includes("waiting_blocked")) {
            alert("BLOCK 체크된 대기자는 배치할 수 없습니다.");
          } else if (String(err?.message || "").includes("waiting_not_found")) {
            alert("해당 대기자가 이미 처리되었습니다.");
          } else if (String(err?.message || "").includes("seat_not_found")) {
            alert("Seat 정보를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.");
          } else {
            console.error("mobile assign error:", err);
            alert("대기 배치에 실패했습니다.");
          }
          fullRender();
        }
        return;
      }

      if (occupied) {
        if (GL.lastSeatTapId === sid && now - Number(GL.lastSeatTapAt || 0) < GLOBAL_MOBILE_SEAT_DOUBLE_MS) {
          GL.lastSeatTapAt = 0;
          GL.lastSeatTapId = "";
          try {
            const { clearSeat } = await loadFirestoreOps();
            setMobileSeatSelection("");
            await clearSeat(sid);
          } catch (err) {
            console.error("mobile clearSeat error:", err);
            fullRender();
          }
          return;
        }
        GL.lastSeatTapAt = now;
        GL.lastSeatTapId = sid;
        setMobileSeatSelection(sid);
        fullRender();
        return;
      }

      GL.lastSeatTapAt = now;
      GL.lastSeatTapId = sid;
      setMobileSeatSelection(sid);
      fullRender();
    }
  });

  GL.app.addEventListener("input", (e) => {
    if (!layoutIsMobile()) return;
    const input = e.target.closest("#globalMobileLookupInput");
    if (!input) return;
    mobileDealerLookupQuery = String(input.value || "");
    const resultEl = GL.app.querySelector("#globalMobileLookupResult");
    if (resultEl) resultEl.innerHTML = buildDealerLookupResultHtml(mobileDealerLookupQuery);
  });
}

/** 1초 타이머용 — DOM 전체를 다시 그리지 않고 시간 칩만 갱신 (스크롤 유지) */
export function refreshGlobalLayoutMobileTimers() {
  if (!GL.app || !layoutIsMobile()) return;
  const root = getGlobalLayoutMobileScrollEl();
  if (!root) {
    renderGlobalLayoutMobile();
    return;
  }

  const rosterByKey = new Map(getActiveDealerRosterForMobile().map((d) => [d.uid || d.waitingId || "", d]));
  root.querySelectorAll(".mobile-seat-row[data-mobile-dealer]").forEach((row) => {
    const key = String(row.getAttribute("data-mobile-dealer") || "").trim();
    const dealer = rosterByKey.get(key);
    if (!dealer) return;
    const currentSeat = resolveDealerCurrentSeat(dealer);
    const nextSeat = resolveDealerNextSeat(dealer);
    const blinkSeat = nextSeat;
    const { isBlinkOn } = blinkSeat
      ? getSeatConfirmHighlightState(toMillis(blinkSeat.seatedAt))
      : { isBlinkOn: false };
    const currentCol = row.querySelector(".mobile-seat-col--current");
    if (currentCol) {
      currentCol.textContent = currentSeat ? seatCanvasDigitsOnly(currentSeat.label, currentSeat.no) || "-" : "-";
    }
    const nextCol = row.querySelector(".mobile-seat-col--next");
    if (nextCol) {
      nextCol.textContent = nextSeat ? seatCanvasDigitsOnly(nextSeat.label, nextSeat.no) || "-" : "-";
    }
    row.classList.toggle("is-confirm-blink", isBlinkOn);
  });

  updateGlobalLayoutWaitingMeta();
  syncGlobalLayoutMetaPills(root);
}

export function renderGlobalLayoutMobile(options = {}) {
  if (!GL.app || !layoutIsMobile()) return;
  if (!options.forceFull && options.sync !== false && trySyncGlobalLayoutMobile()) return;

  captureGlobalLayoutMobileScroll();
  updateGlobalLayoutMetaCounts(GL.globalSeats);

  const wrap = document.createElement("div");
  wrap.className = "mobile global-layout-mobile";

  wrap.innerHTML = `
    <div class="global-mobile-meta">
      <span class="hint-pill" data-meta="seat">${escapeHtml(GL.seatCountEl?.textContent || "SEAT: 0")}</span>
      <span class="hint-pill" data-meta="assigned">${escapeHtml(GL.assignedCountEl?.textContent || "ASSIGNED: 0")}</span>
      <span class="hint-pill" data-meta="wait">${escapeHtml(GL.waitingCountEl?.textContent || "WAIT: 0")}</span>
      <span class="hint-pill hint-pill--block" data-meta="block">${escapeHtml(GL.blockedCountEl?.textContent || "BLOCK: 0")}</span>
    </div>
  `;

  const lookupCard = document.createElement("div");
  lookupCard.className = "card mobile-lookup-card";
  lookupCard.innerHTML = buildDealerLookupCardHtml();

  const canOps = canManageGlobalLayoutOps();

  const seatCard = document.createElement("div");
  seatCard.className = "card";
  seatCard.innerHTML = `
    <div class="mobile-section-head">
      <h3>딜러 명단</h3>
      ${canOps ? `<button id="globalMobileAddManualDealerInline" class="btn primary" type="button">+ 딜러 추가</button>` : ""}
    </div>
  `;

  const dealerRoster = getActiveDealerRosterForMobile();
  if (!dealerRoster.length) {
    seatCard.innerHTML += `<div class="row"><div>딜러</div><div class="muted">없음</div></div>`;
  } else {
    seatCard.innerHTML += `
      <div class="mobile-seat-col-header">
        <span class="mobile-seat-col-header-name">이름</span>
        <span class="mobile-seat-col-header-cell">현재</span>
        <span class="mobile-seat-col-header-cell">다음</span>
      </div>
    `;
    dealerRoster.forEach((dealer) => {
      const isSelf = !!dealer.uid && String(dealer.uid) === String(auth.currentUser?.uid || "");
      const isManual = !dealer.uid && !!dealer.waitingId;
      const canDeleteManual = isManual && dealer.isManualWaiting === true;
      const currentSeat = resolveDealerCurrentSeat(dealer);
      const nextSeat = resolveDealerNextSeat(dealer);
      const currentSeatLabel = currentSeat ? seatCanvasDigitsOnly(currentSeat.label, currentSeat.no) : "";
      const nextSeatLabel = nextSeat ? seatCanvasDigitsOnly(nextSeat.label, nextSeat.no) : "";
      const blinkSeat = nextSeat;
      const { isBlinkOn } = blinkSeat
        ? getSeatConfirmHighlightState(toMillis(blinkSeat.seatedAt))
        : { isBlinkOn: false };
      seatCard.innerHTML += `
        <div class="mobile-seat-row compact ${isBlinkOn ? "is-confirm-blink" : ""}" data-mobile-dealer="${escapeHtml(dealer.uid || dealer.waitingId || "")}">
          <div class="mobile-seat-mainline">
            <div class="mobile-seat-name-cluster">
              <div class="mobile-seat-person ${isSelf ? "is-self" : ""}">${escapeHtml(dealer.name)}</div>
              ${isManual ? `<span class="mobile-seat-eb-meta">테스트</span>` : ""}
            </div>
            <div class="mobile-seat-col mobile-seat-col--current">${escapeHtml(currentSeatLabel) || "-"}</div>
            <div class="mobile-seat-col mobile-seat-col--next">${escapeHtml(nextSeatLabel) || "-"}</div>
            ${
              canOps && canDeleteManual
                ? `<button type="button" class="mobile-seat-more-btn" data-del-manual-waiting="${escapeHtml(dealer.waitingId)}" aria-label="삭제">✕</button>`
                : ""
            }
          </div>
        </div>
      `;
    });
  }

  wrap.append(lookupCard, seatCard);
  GL.app.innerHTML = "";
  GL.app.appendChild(wrap);
  GL.app.classList.remove("with-panel");
  wrap.setAttribute("data-mobile-structure-fp", mobileLayoutStructureFingerprint());
  restoreGlobalLayoutMobileScroll();
  wireGlobalLayoutMobileEventsOnce();
}
