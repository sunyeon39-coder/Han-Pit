import { db } from "../firebase.js";
import {
  doc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  buildSeatAssignedNotificationWrite,
  buildSeatAssignedTargetUrl
} from "../shared/seat-notification-push.js";
import { GL } from "./state.js";
import {
  getAttendanceRef,
  getGlobalSeatDocRef,
  getGlobalSeatDocRefs,
  isEmptyPerson,
  resolveSeatEventBox
} from "./utils.js";
import { findGlobalWaitingEntryRefs } from "./waiting-entry-refs.js";
import { globalWaitingDocRef, personIdentityMatches } from "../shared/tournament-waiting-queue.js";
import { resolveCanonicalWaitingDocId } from "./fs-waiting-merge.js";
import { scheduleSyncLayoutProjection } from "./fs-layout-projection.js";
import { appendSeatHistoryPatch, entryFromSeatOccupant, findGlobalSeatByAnyKey } from "./seat-history.js";
import { assignSelectedWaitingToSeat } from "./fs-assign-waiting-to-seat.js";
import { runFirestoreTransactionWithRetry } from "../shared/firestore-transaction-retry.js";
import { runSerializedGlobalWaitingWrite } from "./global-waiting-write-lock.js";
import { logGlobalLayoutAttendance } from "./attendance-log.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";

function findSeatSeatedByIdentity(identity, excludeSeatId = "") {
  const ex = String(excludeSeatId || "").trim();
  return (
    (GL.globalSeats || []).find((s) => {
      const sid = String(s?.seatId || "").trim();
      if (!sid || sid === ex) return false;
      if (isEmptyPerson(String(s?.person || "").trim())) return false;
      return personIdentityMatches(identity, {
        personUid: s.personUid,
        personEmail: s.personEmail,
        person: s.person
      });
    }) || null
  );
}

/**
 * 복원 대상 딜러를 빼온 좌석(vacatedSeat) — "그 전 근무자"(restoreCandidate)가 지금
 * 다른 좌석에 이미 앉아있지 않다면 원래 착석 시각(seatedAt)을 그대로 유지해 복원하고,
 * 그렇지 않거나 이전 근무자가 없으면 비워둔다. assignSelectedWaitingToSeat 의 중복 좌석
 * 정리(clearDupSeatsInTransaction)는 좌석을 그냥 비우기만 하므로, 이 후속 작업이 없으면
 * 그 전 근무자 정보와 착석 시간이 사라진다.
 */
async function restoreOrEmptyVacatedSeat(vacatedSeat, dealerStint, restoreCandidate) {
  const seatId = String(vacatedSeat?.seatId || "").trim();
  if (!seatId) return;

  const fallbackPairs = (GL.globalSeats || [])
    .filter((s) => String(s?.seatId || "").trim() === seatId)
    .map((s) => resolveSeatEventBox(s));
  const primaryRef = getGlobalSeatDocRef(vacatedSeat, GL.tournamentId);
  const seatRefs = primaryRef ? [primaryRef] : getGlobalSeatDocRefs(vacatedSeat, GL.tournamentId, fallbackPairs);
  if (!seatRefs.length) return;

  const candidateUid = String(restoreCandidate?.personUid || "").trim();
  const candidateEmail = String(restoreCandidate?.personEmail || "").trim();
  const candidateName = String(restoreCandidate?.person || "").trim();
  const candidateSeatedAt = Number(restoreCandidate?.seatedAt) || 0;
  const willRestore = Boolean(restoreCandidate) && !isEmptyPerson(candidateName) && candidateSeatedAt > 0;

  const now = Date.now();
  let logMeta = null;

  await runSerializedGlobalWaitingWrite(() =>
    runFirestoreTransactionWithRetry(db, async (tx) => {
      let seatRef = null;
      let seatSnap = null;
      for (const ref of seatRefs) {
        const snap = await tx.get(ref);
        if (!snap.exists()) continue;
        seatRef = ref;
        seatSnap = snap;
        break;
      }
      if (!seatRef || !seatSnap?.exists()) return;
      const seatData = seatSnap.data() || {};

      // 그 사이 다른 조작으로 이미 누가 배치됐다면 덮어쓰지 않는다.
      if (!isEmptyPerson(String(seatData.person || "").trim())) return;

      const dealerHistoryEntry = entryFromSeatOccupant(
        {
          person: dealerStint.person,
          personUid: dealerStint.personUid,
          personEmail: dealerStint.personEmail,
          seatedAt: dealerStint.seatedAt
        },
        now,
        "replace"
      );
      const nextHistory = appendSeatHistoryPatch(seatData.seatHistory, dealerHistoryEntry);

      const candidateWaitingRefs = willRestore
        ? [
            globalWaitingDocRef(
              db,
              GL.tournamentId,
              resolveCanonicalWaitingDocId({ uid: candidateUid, name: candidateName })
            ),
            ...findGlobalWaitingEntryRefs(db, GL.tournamentId, GL.globalWaiting, {
              uid: candidateUid,
              email: candidateEmail,
              name: candidateName
            })
          ]
        : [];
      const candidateWaitingSnaps = candidateWaitingRefs.length
        ? await Promise.all(candidateWaitingRefs.map((r) => tx.get(r)))
        : [];

      tx.set(
        seatRef,
        willRestore
          ? {
              person: candidateName,
              personUid: candidateUid,
              personEmail: candidateEmail,
              seatedAt: candidateSeatedAt,
              status: "occupied",
              instantConfirm: true,
              incomingPerson: "",
              incomingPersonUid: "",
              incomingPersonEmail: "",
              incomingAt: null,
              updatedAt: now,
              updatedAtServer: serverTimestamp(),
              ...(nextHistory ? { seatHistory: nextHistory } : {})
            }
          : {
              person: "비어있음",
              personUid: "",
              personEmail: "",
              seatedAt: null,
              status: "empty",
              incomingPerson: "",
              incomingPersonUid: "",
              incomingPersonEmail: "",
              incomingAt: null,
              updatedAt: now,
              updatedAtServer: serverTimestamp(),
              ...(nextHistory ? { seatHistory: nextHistory } : {})
            },
        { merge: true }
      );

      if (willRestore) {
        for (let i = 0; i < candidateWaitingRefs.length; i++) {
          if (candidateWaitingSnaps[i]?.exists()) tx.delete(candidateWaitingRefs[i]);
        }
        if (candidateUid) {
          // 다시 앉힌 이전 근무자 화면에도 "내 배치됨"이 떠야 한다 — 알림은 다시 울리지 않게
          // acknowledged:true로 배지만 갱신한다.
          const restoredEventId = String(seatData.currentEventId || seatData.mappedEventId || "").trim();
          const restoredBoxId = String(seatData.boxId || "").trim();
          tx.set(
            doc(db, "layout_notifications", candidateUid),
            {
              ...buildSeatAssignedNotificationWrite(candidateUid, {
                tournamentId: GL.tournamentId,
                eventId: restoredEventId,
                boxId: restoredBoxId,
                seatId,
                seatLabel: String(vacatedSeat.label || vacatedSeat.no || "").trim(),
                targetUrl: buildSeatAssignedTargetUrl(GL.tournamentId, restoredEventId, restoredBoxId),
                createdAt: now,
                notifyAt: now,
                updatedAt: now,
                updatedAtServer: serverTimestamp()
              }),
              acknowledged: true,
              acknowledgedAt: now
            },
            { merge: true }
          );
          tx.set(
            getAttendanceRef(db, GL.tournamentId, candidateUid),
            {
              uid: candidateUid,
              email: candidateEmail,
              name: candidateName,
              tournamentId: GL.tournamentId,
              status: "assigned",
              statusChangedAt: now,
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
            { merge: true }
          );
        }
      }

      logMeta = {
        seatId,
        seatLabel: String(vacatedSeat.label || vacatedSeat.no || "").trim(),
        eventId: String(seatData.currentEventId || seatData.mappedEventId || "").trim(),
        boxId: String(seatData.boxId || "").trim(),
        restored: willRestore,
        candidateUid,
        candidateName
      };
    })
  );

  if (logMeta) {
    scheduleSyncLayoutProjection(logMeta.eventId, logMeta.boxId);
    if (logMeta.restored && logMeta.candidateUid) {
      logGlobalLayoutAttendance({
        uid: logMeta.candidateUid,
        nickname: logMeta.candidateName,
        action: "assigned",
        eventId: logMeta.eventId,
        boxId: logMeta.boxId,
        seatId: logMeta.seatId,
        seatLabel: logMeta.seatLabel,
        detail: "배치 이력 복원으로 이전 근무자 재배치"
      });
    }
  }
}

/**
 * "SEAT N 배치 이력" 모달에서 과거 항목을 골라 그 딜러를 지금 이 좌석에 다시 배치한다.
 * - 그 딜러가 지금 다른 좌석에 앉아 있으면 거기서 빼온다(assignSelectedWaitingToSeat의
 *   중복 좌석 정리에 이미 포함됨).
 * - 빼온 좌석은 그 전 근무자가 다른 곳에 앉아 있지 않은 한 그 사람으로 되돌리고,
 *   착석 시각(경과 시간)은 원래 값을 그대로 유지한다.
 * - 이 좌석에 지금 앉아 있던 사람은 대기열로 돌아간다(기존 교체 로직과 동일).
 */
export async function restoreSeatFromHistoryEntry(seatKey, historyEntry) {
  if (!canManageGlobalLayoutOps()) return false;
  if (GL.seatMutationInFlight) return false;

  const targetSeat = findGlobalSeatByAnyKey(seatKey);
  if (!targetSeat) return false;
  const targetSeatId = String(targetSeat.seatId || "").trim();
  if (!targetSeatId) return false;

  const person = String(historyEntry?.person || "").trim();
  if (isEmptyPerson(person)) return false;
  const personUid = String(historyEntry?.personUid || "").trim();
  const personEmail = String(historyEntry?.personEmail || "").trim();
  const identity = { uid: personUid, email: personEmail, name: person };

  if (
    !isEmptyPerson(String(targetSeat.person || "").trim()) &&
    personIdentityMatches(identity, {
      personUid: targetSeat.personUid,
      personEmail: targetSeat.personEmail,
      person: targetSeat.person
    })
  ) {
    return false;
  }

  const sourceSeat = findSeatSeatedByIdentity(identity, targetSeatId);
  let dealerStint = null;
  let restoreCandidate = null;
  if (sourceSeat) {
    dealerStint = {
      person: String(sourceSeat.person || "").trim(),
      personUid: String(sourceSeat.personUid || "").trim(),
      personEmail: String(sourceSeat.personEmail || "").trim(),
      seatedAt: Number(sourceSeat.seatedAt) || Date.now()
    };
    const hist = Array.isArray(sourceSeat.seatHistory) ? sourceSeat.seatHistory.filter(Boolean) : [];
    const prevEntry = hist[hist.length - 1] || null;
    if (prevEntry && !isEmptyPerson(String(prevEntry.person || "").trim())) {
      const prevIdentity = {
        uid: prevEntry.personUid,
        email: prevEntry.personEmail,
        name: prevEntry.person
      };
      const seatedElsewhere = findSeatSeatedByIdentity(prevIdentity, String(sourceSeat.seatId || "").trim());
      if (!seatedElsewhere) restoreCandidate = prevEntry;
    }
  }

  const waitingLike = {
    id: resolveCanonicalWaitingDocId({ uid: personUid, name: person }),
    uid: personUid,
    email: personEmail,
    name: person,
    tournamentId: GL.tournamentId
  };

  try {
    await assignSelectedWaitingToSeat(targetSeatId, waitingLike, Date.now(), { immediate: true });
  } catch (err) {
    if (String(err?.message || "").trim() === "same_person_noop") return false;
    throw err;
  }

  if (sourceSeat && dealerStint) {
    await restoreOrEmptyVacatedSeat(sourceSeat, dealerStint, restoreCandidate);
  }
  return true;
}
