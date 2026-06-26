/**
 * 출석 + 운영 스냅샷 기준 global_waiting 복구
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
 *   node scripts/recover-waiting-from-attendance.mjs "APL JEJU" --apply
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const admin = require(
  join(dirname(fileURLToPath(import.meta.url)), "../functions/node_modules/firebase-admin")
);

const PROJECT_ID = "hanagency-c2c0e";
const EMPTY_PERSON = new Set(["", "비어있음", "빈자리", "empty"]);

const SNAPSHOT_NAMES_BY_TOURNAMENT = {
  "APL JEJU": [
    "지렁이",
    "김태중",
    "sia",
    "명환",
    "SIRI",
    "김진현",
    "황인엽",
    "김해진",
    "작준.",
    "SKY",
    "오시우",
    "윤인규"
  ]
};

function isEmptyPerson(name = "") {
  return EMPTY_PERSON.has(String(name || "").trim());
}

function normName(name = "") {
  return String(name || "").trim().toLowerCase();
}

function waitingRowBelongsToTournament(row = {}, tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const wTid = String(row?.tournamentId || "").trim();
  if (!wTid) return true;
  return wTid === tid;
}

function personInWaiting(waiting = [], tournamentId = "", person = {}) {
  const uid = String(person.uid || "").trim();
  const email = String(person.email || "").trim();
  const name = String(person.name || "").trim();
  for (const w of waiting || []) {
    if (!waitingRowBelongsToTournament(w, tournamentId)) continue;
    const wUid = String(w?.uid || "").trim();
    const wEmail = String(w?.email || "").trim();
    const wName = String(w?.name || "").trim();
    if (uid && wUid && uid === wUid) return true;
    if (email && wEmail && email === wEmail) return true;
    if (name && wName && name === wName) return true;
  }
  return false;
}

function isPersonSeated(seats = [], person = {}) {
  const pUid = String(person.uid || "").trim();
  const pEmail = String(person.email || "").trim().toLowerCase();
  const pName = String(person.name || "").trim();
  for (const s of seats || []) {
    if (isEmptyPerson(s?.person)) continue;
    const sUid = String(s?.personUid || "").trim();
    const sEmail = String(s?.personEmail || "").trim().toLowerCase();
    const sName = String(s?.person || "").trim();
    if (pUid && sUid && pUid === sUid) return true;
    if (pEmail && sEmail && pEmail === sEmail) return true;
    if (pName && sName && pName === sName) return true;
  }
  return false;
}

function resolveJoinMs(att = {}) {
  const keys = ["statusChangedAt", "checkedInAt", "updatedAt"];
  for (const key of keys) {
    const ms = Number(att?.[key] || 0);
    if (ms > 0) return ms;
  }
  return Date.now();
}

function rebuildWaiting(waitingArr, tournamentId, person, joinMs) {
  const filtered = waitingArr.filter((w) => {
    if (!waitingRowBelongsToTournament(w, tournamentId)) return true;
    return !personInWaiting([w], tournamentId, person);
  });
  const uid = String(person.uid || "").trim();
  return [
    ...filtered,
    {
      id: uid ? `w_${uid}` : `wait_${joinMs}`,
      uid,
      email: String(person.email || "").trim(),
      name: String(person.name || "").trim() || uid || "-",
      tournamentId,
      joinedAt: joinMs,
      source: "attendance_restore_script"
    }
  ];
}

const args = process.argv.slice(2).filter((a) => a !== "--apply");
const apply = process.argv.includes("--apply");
const tournamentId = String(args[0] || "APL JEJU").trim();
if (!tournamentId) {
  console.error('tournamentId 필요. 예: node scripts/recover-waiting-from-attendance.mjs "APL JEJU"');
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

console.log(`\n=== 대기열 복구 (${apply ? "APPLY" : "DRY-RUN"}) tournamentId=${JSON.stringify(tournamentId)} ===\n`);

const waitingSnap = await db.collection("layout_shared").doc("global_waiting").get();
const waitingState = waitingSnap.exists ? waitingSnap.data() || {} : { version: 2, waiting: [] };
let waitingArr = Array.isArray(waitingState.waiting) ? [...waitingState.waiting] : [];
const tidWaiting = waitingArr.filter((w) => waitingRowBelongsToTournament(w, tournamentId));

const seatsSnap = await db.collection("tournaments").doc(tournamentId).collection("global_seats").get();
const seats = seatsSnap.docs.map((d) => ({ seatId: d.id, ...(d.data() || {}) }));

const usersSnap = await db.collection("users").get();
const usersByNick = new Map();
for (const d of usersSnap.docs) {
  const data = d.data() || {};
  const nick = String(data.nickname || data.name || "").trim();
  if (!nick) continue;
  usersByNick.set(normName(nick), {
    uid: d.id,
    email: String(data.email || "").trim(),
    name: nick
  });
}

const attSnap = await db.collection("dealer_attendance").get();
const prefix = `${tournamentId}__`;
const attendanceByUid = new Map();
for (const d of attSnap.docs) {
  if (!String(d.id).startsWith(prefix)) continue;
  const data = d.data() || {};
  const uid = String(data.uid || "").trim();
  if (uid) attendanceByUid.set(uid, { id: d.id, ...data });
}

const missing = new Map();
const addMissing = (person, joinMs, source) => {
  const key = person.uid || normName(person.name) || person.email;
  if (!key || missing.has(key)) return;
  if (isPersonSeated(seats, person)) return;
  if (personInWaiting(waitingArr, tournamentId, person)) return;
  missing.set(key, { ...person, joinedAt: joinMs, source });
};

for (const d of attSnap.docs) {
  if (!String(d.id).startsWith(prefix)) continue;
  const data = d.data() || {};
  const status = String(data.status || "").trim();
  if (status !== "waiting" && status !== "checked_in") continue;
  const uid = String(data.uid || "").trim();
  addMissing(
    {
      uid,
      email: String(data.email || "").trim(),
      name: String(data.nickname || data.name || "").trim()
    },
    resolveJoinMs(data),
    "attendance"
  );
}

for (const rawName of SNAPSHOT_NAMES_BY_TOURNAMENT[tournamentId] || []) {
  const name = String(rawName || "").trim();
  if (!name) continue;
  const user = usersByNick.get(normName(name));
  addMissing(
    {
      uid: String(user?.uid || "").trim(),
      email: String(user?.email || "").trim(),
      name: user?.name || name
    },
    Date.now(),
    "snapshot"
  );
}

const missingList = [...missing.values()];
console.log(`[현재] global_waiting(대회)=${tidWaiting.length}명`);
console.log(`[복구 대상] ${missingList.length}명`);
for (const m of missingList) {
  console.log(`  - ${m.name || m.uid || m.email} (${m.source}, uid=${m.uid || "-"})`);
}

if (!missingList.length) {
  console.log("\n복구할 대상이 없습니다.\n");
  process.exit(0);
}

if (!apply) {
  console.log('\n반영: node scripts/recover-waiting-from-attendance.mjs "' + tournamentId + '" --apply\n');
  process.exit(0);
}

const now = Date.now();
for (const person of missingList) {
  waitingArr = rebuildWaiting(waitingArr, tournamentId, person, person.joinedAt || now);
  if (!person.uid) continue;
  await db
    .collection("dealer_attendance")
    .doc(`${tournamentId}__${person.uid}`)
    .set(
      {
        uid: person.uid,
        email: person.email,
        name: person.name,
        nickname: person.name,
        tournamentId,
        status: "waiting",
        statusChangedAt: person.joinedAt || now,
        checkedInAt: person.joinedAt || now,
        checkedOutAt: null,
        updatedAt: now
      },
      { merge: true }
    );
}

await db
  .collection("layout_shared")
  .doc("global_waiting")
  .set(
    {
      ...waitingState,
      version: 2,
      waiting: waitingArr,
      updatedAt: now
    },
    { merge: true }
  );

const after = waitingArr.filter((w) => waitingRowBelongsToTournament(w, tournamentId)).length;
console.log(`\n✅ global_waiting 복구 완료 — 대회 대기 ${after}명\n`);
process.exit(0);
