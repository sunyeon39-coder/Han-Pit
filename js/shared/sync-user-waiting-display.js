import { db } from "../firebase.js";
import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const WAITING_REF = () => doc(db, "layout_shared", "global_waiting");

/**
 * 닉네임 변경 후 대기 목록·출석 대기 병합에 쓰이는 표시명을 Firestore에 맞춥니다.
 * @returns {Promise<{ waitingRows: number, attendanceDocs: number }>}
 */
export async function syncUserDisplayNameAfterNicknameChange(uid = "", nickname = "") {
  const userUid = String(uid || "").trim();
  const name = String(nickname || "").trim();
  if (!userUid || !name) {
    return { waitingRows: 0, attendanceDocs: 0 };
  }

  const waitingRows = await syncGlobalWaitingNameForUser(userUid, name);
  const attendanceDocs = await syncDealerAttendanceNicknameForUser(userUid, name);
  return { waitingRows, attendanceDocs };
}

async function syncGlobalWaitingNameForUser(userUid, name) {
  let updated = 0;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(WAITING_REF());
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const list = Array.isArray(data.waiting) ? data.waiting : [];
      let changed = false;

      const next = list.map((item) => {
        if (!item || typeof item !== "object") return item;
        if (String(item.uid || "").trim() !== userUid) return item;
        if (String(item.name || "").trim() === name) return item;
        changed = true;
        updated += 1;
        return { ...item, name };
      });

      if (!changed) return;

      tx.set(
        WAITING_REF(),
        {
          ...data,
          version: 2,
          waiting: next,
          updatedAt: Date.now(),
          updatedAtServer: serverTimestamp()
        },
        { merge: true }
      );
    });
  } catch (err) {
    console.error("syncGlobalWaitingNameForUser error:", err);
    throw err;
  }
  return updated;
}

async function syncDealerAttendanceNicknameForUser(userUid, name) {
  let updated = 0;
  try {
    const snap = await getDocs(
      query(collection(db, "dealer_attendance"), where("uid", "==", userUid))
    );
    if (snap.empty) return 0;

    let batch = writeBatch(db);
    let ops = 0;

    const commitIfNeeded = async (force = false) => {
      if (!ops) return;
      if (!force && ops < 400) return;
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    };

    for (const d of snap.docs) {
      const data = d.data() || {};
      if (String(data.nickname || "").trim() === name) continue;
      batch.set(d.ref, { nickname: name, updatedAt: Date.now() }, { merge: true });
      ops += 1;
      updated += 1;
      if (ops >= 400) await commitIfNeeded(true);
    }

    await commitIfNeeded(true);
  } catch (err) {
    console.error("syncDealerAttendanceNicknameForUser error:", err);
    throw err;
  }
  return updated;
}
