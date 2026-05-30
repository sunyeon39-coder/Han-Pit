import { db } from "../firebase.js";
import {
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { GL } from "./state.js";
import {
  ensureGlobalSeatFirestoreDoc,
  getAttendanceRef,
  getGlobalSeatDocRef,
  isEmptyPerson,
  resolveSeatEventBox
} from "./utils.js";
import { getCandidateSeatRefsForPerson } from "./seat-candidates.js";
import { getCurrentTournamentWaiting, resolveSelectedWaitingForAssign } from "./waiting.js";
import { renderWaiting } from "./panel-ui.js";
import {
  ensureLayoutEventShellForGlobalOps,
  hasGlobalSeatForEventBox,
  scheduleSyncLayoutProjection,
  validateLayoutEventForGlobalOps
} from "./fs-layout-projection.js";
import { getEventCardIdFromRecord } from "../shared/tournament-event-instance.js";
import { buildSeatAssignedNotifyMessage } from "../shared/seat-notification-label.js";
import { rebuildWaitingAfterSeatToWait } from "./fs-waiting-merge.js";
import { pushGlobalUndo } from "./undo-stack.js";
import { clearMyWaitingPick } from "./waiting-picks.js";
import {
  applyOptimisticAssign,
  flushOptimisticGlobalLayoutUi
} from "./optimistic-seat-mutation.js";
import { triggerOptimisticMobileSeatAssignedAlert } from "../shared/optimistic-seat-assigned-notify.js";

function notifyOptimisticSeatAssignedForWaiting(waiting, seat, targetSeatId) {
  const uid = String(waiting?.uid || "").trim();
  if (!uid) return;
  const { eventId, boxId } = resolveSeatEventBox(seat);
  triggerOptimisticMobileSeatAssignedAlert({
    uid,
    eventId,
    boxId,
    seatId: targetSeatId,
    seatLabel: String(seat.label || seat.no || "").trim(),
    targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(eventId)}&boxId=${encodeURIComponent(boxId)}&focusSeatId=${encodeURIComponent(targetSeatId)}`
  });
}

export async function assignSelectedWaitingToSeat(seatId = "") {
  const targetSeatId = String(seatId || "").trim();
  if (!targetSeatId || GL.seatMutationInFlight) return;

  const seat = GL.globalSeats.find((s) => String(s.seatId || "").trim() === targetSeatId);
  if (!seat) return;

  const waiting = resolveSelectedWaitingForAssign();
  if (!waiting) {
    GL.selectedWaitingId = "";
    renderWaiting(getCurrentTournamentWaiting());
    throw new Error("waiting_not_found");
  }
  if (waiting.blockChecked === true) {
    throw new Error("waiting_blocked");
  }

  const { eventId: ev0, boxId: bx0 } = resolveSeatEventBox(seat);
  if (hasGlobalSeatForEventBox(ev0, bx0, targetSeatId)) {
    void ensureLayoutEventShellForGlobalOps(ev0, bx0);
  } else {
    const layoutGate = await validateLayoutEventForGlobalOps(ev0, bx0, {
      requireSeatId: targetSeatId,
      ensureShell: true,
      trustGlobalSeats: true
    });
    if (!layoutGate.ok) {
      alert(layoutGate.message);
      return;
    }
  }

  const fallbackPairs = (GL.globalSeats || [])
    .filter((s) => String(s?.seatId || "").trim() === targetSeatId)
    .map((s) => resolveSeatEventBox(s));

  let seatRef = getGlobalSeatDocRef(seat, GL.tournamentId);
  let canonicalSeatEventId = String(seat.currentEventId || seat.mappedEventId || "").trim();
  let canonicalSeatBoxId = String(seat.boxId || "").trim();

  if (!seatRef) {
    const seatDoc = await ensureGlobalSeatFirestoreDoc(seat, GL.tournamentId, fallbackPairs);
    if (!seatDoc?.ref) throw new Error("seat_not_found");
    seatRef = seatDoc.ref;
    canonicalSeatEventId = String(
      seatDoc.data.currentEventId || seatDoc.data.mappedEventId || canonicalSeatEventId || ""
    ).trim();
    canonicalSeatBoxId = String(seatDoc.data.boxId || canonicalSeatBoxId || "").trim();
    const idx = GL.globalSeats.findIndex((s) => String(s.seatId || "").trim() === targetSeatId);
    if (idx >= 0 && seatDoc.docId) {
      GL.globalSeats[idx] = { ...GL.globalSeats[idx], __firestoreDocId: seatDoc.docId };
    }
  }

  if (!canonicalSeatEventId || !canonicalSeatBoxId) {
    const fallback = resolveSeatEventBox(seat);
    canonicalSeatEventId = canonicalSeatEventId || fallback.eventId;
    canonicalSeatBoxId = canonicalSeatBoxId || fallback.boxId;
  }

  const now = Date.now();
  const waitingRef = doc(db, "layout_shared", "global_waiting");
  const touchedProjectionKeys = new Set();

  let undoSeatBefore = null;
  let undoWaitingBefore = null;

  const rollbackOptimistic = applyOptimisticAssign({ targetSeatId, waiting, seat });
  flushOptimisticGlobalLayoutUi();
  notifyOptimisticSeatAssignedForWaiting(waiting, seat, targetSeatId);
  void clearMyWaitingPick();

  GL.seatMutationInFlight = true;
  try {
    await runTransaction(db, async (tx) => {
      const waitingId = String(waiting.id || "").trim();
      const waitingUid = String(waiting.uid || "").trim();
      const waitingEmail = String(waiting.email || "").trim();
      const waitingEmailLc = waitingEmail.toLowerCase();
      const waitingName = String(waiting.name || "").trim();
      const waitingTournamentId = String(waiting.tournamentId || GL.tournamentId).trim();

      const seatSnap = await tx.get(seatRef);
      if (!seatSnap?.exists()) throw new Error("seat_not_found");
      const seatData = seatSnap.data() || {};
      canonicalSeatEventId =
        String(seatData.currentEventId || seatData.mappedEventId || canonicalSeatEventId || "").trim();
      canonicalSeatBoxId = String(seatData.boxId || canonicalSeatBoxId || "").trim();

      let eventCardLabel =
        getEventCardIdFromRecord({ id: canonicalSeatEventId }) || canonicalSeatEventId || "이벤트";
      if (canonicalSeatEventId && GL.tournamentId) {
        const eventSnap = await tx.get(
          doc(db, "tournaments", GL.tournamentId, "events", canonicalSeatEventId)
        );
        if (eventSnap.exists()) {
          eventCardLabel =
            getEventCardIdFromRecord({
              id: canonicalSeatEventId,
              cardId: (eventSnap.data() || {}).cardId
            }) || eventCardLabel;
        }
      }

      const wasOccupied = !isEmptyPerson(String(seatData.person || "").trim());

      if (wasOccupied) {
        const seatPersonUid = String(seatData.personUid || "").trim();
        const seatPersonEmail = String(seatData.personEmail || "").trim();
        const seatEmailLc = seatPersonEmail.toLowerCase();

        const samePersonOnTargetSeat =
          (waitingUid && seatPersonUid && waitingUid === seatPersonUid) ||
          (waitingEmailLc && seatEmailLc && waitingEmailLc === seatEmailLc);

        if (samePersonOnTargetSeat) {
          throw new Error("same_person_noop");
        }
      }

      const clearDupSeatsForPerson = async (person) => {
        const pUid = String(person.uid || "").trim();
        const pEmail = String(person.email || "").trim();
        const pEmailLc = pEmail.toLowerCase();
        const pName = String(person.name || "").trim();
        if (!pUid && !pEmail && !pName) return;

        const refs = getCandidateSeatRefsForPerson(
          db,
          GL.tournamentId,
          GL.globalSeats,
          { uid: pUid, email: pEmail, name: pName },
          targetSeatId
        );

        for (const ref of refs) {
          const docSnap = await tx.get(ref);
          if (!docSnap.exists()) continue;
          const data = docSnap.data() || {};
          const docSeatId = String(data.seatId || "").trim();
          if (docSeatId === targetSeatId) continue;
          const dUid = String(data.personUid || "").trim();
          const dEmail = String(data.personEmail || "").trim().toLowerCase();
          const dName = String(data.person || "").trim();
          const sameUser =
            (pUid && dUid && pUid === dUid) ||
            (pEmailLc && dEmail && pEmailLc === dEmail) ||
            (!pUid && !pEmail && pName && dName === pName);
          if (!sameUser) continue;
          tx.set(
            ref,
            {
              person: "비어있음",
              personUid: "",
              personEmail: "",
              seatedAt: null,
              status: "empty",
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
            { merge: true }
          );
          const kEvent = String(data.currentEventId || data.mappedEventId || "").trim();
          const kBox = String(data.boxId || "").trim();
          if (kEvent && kBox) touchedProjectionKeys.add(`${kEvent}__${kBox}`);
        }
      };

      await clearDupSeatsForPerson({ uid: waitingUid, email: waiting.email, name: waitingName });

      const waitingSnap = await tx.get(waitingRef);
      const waitingData = waitingSnap.exists() ? waitingSnap.data() || {} : { waiting: [] };
      const waitingArr = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
      undoWaitingBefore = JSON.parse(JSON.stringify(waitingArr));

      let nextWaiting = waitingArr.filter((w) => {
        if (!w || typeof w !== "object") return false;
        const wId = String(w.id || "").trim();
        const wUid = String(w.uid || "").trim();
        const wEmail = String(w.email || "").trim();
        const wName = String(w.name || "").trim();
        const wTid = String(w.tournamentId || "").trim();
        const sameTournament = !wTid || wTid === waitingTournamentId;
        if (!sameTournament) return true;
        if (waitingId && wId === waitingId) return false;
        if (waitingUid && wUid && wUid === waitingUid) return false;
        if (waitingEmail && wEmail && wEmail === waitingEmail) return false;
        if (!waitingUid && !waitingEmail && waitingName && wName === waitingName) return false;
        return true;
      });

      let bumpedPrevHasOtherSeat = false;

      if (wasOccupied) {
        const prevUid = String(seatData.personUid || "").trim();
        const prevEmail = String(seatData.personEmail || "").trim();
        const prevName = String(seatData.person || "").trim();

        await clearDupSeatsForPerson({
          uid: prevUid,
          email: prevEmail,
          name: prevName
        });

        if (!isEmptyPerson(prevName)) {
          const otherRefs = getCandidateSeatRefsForPerson(
            db,
            GL.tournamentId,
            GL.globalSeats,
            { uid: prevUid, email: prevEmail, name: prevName },
            targetSeatId
          );

          for (const ref of otherRefs) {
            const ds = await tx.get(ref);
            if (!ds.exists()) continue;
            const d = ds.data() || {};
            const dName = String(d.person || "").trim();
            if (isEmptyPerson(dName)) continue;
            const dUid = String(d.personUid || "").trim();
            const dEmail = String(d.personEmail || "").trim();
            const same =
              (prevUid && dUid && prevUid === dUid) ||
              (prevEmail && dEmail && prevEmail === dEmail) ||
              (!prevUid && !prevEmail && prevName && dName === prevName);
            if (same) {
              bumpedPrevHasOtherSeat = true;
              break;
            }
          }

          if (!bumpedPrevHasOtherSeat) {
            nextWaiting = rebuildWaitingAfterSeatToWait(
              nextWaiting,
              GL.tournamentId,
              { uid: prevUid, email: prevEmail, name: prevName },
              now,
              { source: "seat_swap" }
            );
          }
        }

        if (prevUid) {
          tx.set(
            getAttendanceRef(db, GL.tournamentId, prevUid),
            {
              uid: prevUid,
              email: prevEmail,
              name: prevName,
              tournamentId: GL.tournamentId,
              status: bumpedPrevHasOtherSeat ? "assigned" : "waiting",
              statusChangedAt: now,
              updatedAt: now,
              updatedAtServer: serverTimestamp()
            },
            { merge: true }
          );

          if (!bumpedPrevHasOtherSeat) {
            tx.set(
              doc(db, "layout_notifications", prevUid),
              {
                type: "seat_cleared",
                acknowledged: true,
                seatId: "",
                seatLabel: "",
                eventId: "",
                eventTitle: "",
                boxId: "",
                targetUrl: "",
                message: "",
                updatedAt: now,
                updatedAtServer: serverTimestamp()
              },
              { merge: true }
            );
          }
        }
      }

      undoSeatBefore = {
        person: String(seatData.person || "").trim(),
        personUid: String(seatData.personUid || "").trim(),
        personEmail: String(seatData.personEmail || "").trim(),
        seatedAt: seatData.seatedAt ? Number(seatData.seatedAt) : null,
        status: isEmptyPerson(String(seatData.person || "").trim()) ? "empty" : "occupied"
      };

      tx.set(
        seatRef,
        {
          person: String(waiting.name || "").trim(),
          personUid: String(waiting.uid || "").trim(),
          personEmail: String(waiting.email || "").trim(),
          seatedAt: now,
          status: "occupied",
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      tx.set(
        waitingRef,
        {
          ...waitingData,
          version: 2,
          waiting: nextWaiting,
          updatedAt: now,
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );

      if (waiting.uid) {
        tx.set(
          getAttendanceRef(db, GL.tournamentId, waiting.uid),
          {
            uid: String(waiting.uid || "").trim(),
            email: String(waiting.email || "").trim(),
            name: String(waiting.name || "").trim(),
            tournamentId: GL.tournamentId,
            status: "assigned",
            statusChangedAt: now,
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );

        tx.set(
          doc(db, "layout_notifications", waiting.uid),
          {
            type: "seat_assigned",
            acknowledged: false,
            createdAt: now,
            tournamentId: GL.tournamentId,
            eventId: canonicalSeatEventId,
            eventTitle: eventCardLabel,
            boxId: canonicalSeatBoxId,
            seatId: seat.seatId || "",
            seatLabel: seat.label || seat.no || "",
            targetUrl: `./layout.html?tournamentId=${encodeURIComponent(GL.tournamentId)}&eventId=${encodeURIComponent(canonicalSeatEventId)}&boxId=${encodeURIComponent(canonicalSeatBoxId)}&focusSeatId=${encodeURIComponent(seat.seatId || "")}`,
            message: buildSeatAssignedNotifyMessage({
              eventId: canonicalSeatEventId,
              cardId: eventCardLabel,
              seatLabel: seat.label || seat.no || ""
            }),
            updatedAt: now,
            updatedAtServer: serverTimestamp()
          },
          { merge: true }
        );
      }
    });
    flushOptimisticGlobalLayoutUi();
  } catch (err) {
    rollbackOptimistic();
    flushOptimisticGlobalLayoutUi();
    throw err;
  } finally {
    GL.seatMutationInFlight = false;
  }

  GL.selectedWaitingId = "";
  GL.selectedSeatIds.clear();
  GL.selectedSeatIds.add(targetSeatId);
  const ev = String(canonicalSeatEventId || "").trim();
  const bx = String(canonicalSeatBoxId || "").trim();
  pushGlobalUndo({
    kind: "assign",
    targetSeatId,
    eventId: ev,
    boxId: bx,
    waiting: JSON.parse(JSON.stringify(waiting)),
    waitingBefore: Array.isArray(undoWaitingBefore) ? undoWaitingBefore : [],
    seatBefore: undoSeatBefore || null
  });
  scheduleSyncLayoutProjection(ev, bx);
  for (const k of touchedProjectionKeys) {
    const [e, b] = String(k || "").split("__");
    if (!e || !b) continue;
    if (e === ev && b === bx) continue;
    scheduleSyncLayoutProjection(e, b);
  }
}
