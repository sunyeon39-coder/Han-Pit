/**
 * 출석(dealer_attendance)에는 waiting/checked_in 인데 global_waiting 에 없는 사람을 복구합니다.
 *
 * 실행:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
 *   node scripts/recover-waiting-from-attendance.mjs "APL JEJU"          # dry-run
 *   node scripts/recover-waiting-from-attendance.mjs "APL JEJU" --apply   # Firestore 반영
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const admin = require(
  join(dirname(fileURLToPath(import.meta.url)), "../functions/node_modules/firebase-admin")
);

const PROJECT_ID = "hanagency-c2c0e";
const TERMINAL = new Set(["checked_out", "off"]);
const EMPTY_PERSON = new Set(["", "비어있음", "빈자리", "empty"]);

function isEmptyPerson(name = "") {
  return EMPTY_PERSON.has(String(name || "").trim());
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
  console.error("tournamentId 필요. 예: node scripts/recover-waiting-from-attendance.mjs \"APL JEJU\"");
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

console.log(`\n=== 대기열 복구 (${apply ? "APPLY" : "DRY-RUN"}) tournamentId=${JSON.stringify(tournamentId)} ===\n`);

const waitingSnap = await db.collection("layout_shared").doc("global_waiting").get();
const waitingState = waitingSnap.exists ? waitingSnap.data() || {} : { version: 2, waiting: [] };
const waitingArr = Array.isArray(waitingState.waiting) ? [...waitingState.waiting] : [];
const tidWaiting = waitingArr.filter((w) => waitingRowBelongsToTournament(w, tournamentId));

const seatsSnap = await db.collection("tournaments").doc(tournamentId).collection("global_seats").get();
const seats = seatsSnap.docs.map((d) => ({ seatId: d.id, ...(d.data() || {}) }));

const attSnap = await db.collection("dealer_attendance").get();
const prefix = `${tournamentId}__`;
const attendanceRows = [];
for (const d of attSnap.docs) {
  if (!String(d.id).startsWith(prefix)) continue;
  const data = d.data() || {};
  const status = String(data.status || "").trim();
  if (status !== "waiting" && status !== "checked_in") continue;
  if (TERMINAL.has(status)) continue;
  attendanceRows.push({ id: d.id, ...data });
}

const missing = [];
for (const row of attendanceRows) {
  const uid = String(row.uid || "").trim();
  const person = {
    uid,
    email: String(row.email || "").trim(),
    name: String(row.nickname || row.name || "").trim()
  };
  if (!person.uid && !person.email && !person.name) continue;
  if (isPersonSeated(seats, person)) continue;
  if (personInWaiting(waitingArr, tournamentId, person)) continue;
  missing.push({ ...person, joinedAt: resolveJoinMs(row), attendanceId: row.id });
}

console.log(`[현재] global_waiting(대회)=${tidWaiting.length}명, 출석 waiting/checked_in=${attendanceRows.length}명`);
console.log(`[복구 대상] ${missing.length}명`);
for (const m of missing) {
  console.log(`  - ${m.name || m.uid || m.email} (uid=${m.uid || "-"}, join=${new Date(m.joinedAt).toISOString()})`);
}

if (!missing.length) {
  console.log("\n복구할 대상이 없습니다.\n");
  process.exit(0);
}

if (!apply) {
  console.log('\n반영하려면: node scripts/recover-waiting-from-attendance.mjs "' + tournamentId + '" --apply\n');
  process.exit(0);
}

let nextWaiting = waitingArr;
for (const person of missing) {
  nextWaiting = rebuildWaiting(nextWaiting, tournamentId, person, person.joinedAt);
}

await db
  .collection("layout_shared")
  .doc("global_waiting")
  .set(
    {
      ...waitingState,
      version: 2,
      waiting: nextWaiting,
      updatedAt: Date.now()
    },
    { merge: true }
  );

console.log(`\n✅ global_waiting 에 ${missing.length}명 복구 완료 (총 ${nextWaiting.filter((w) => waitingRowBelongsToTournament(w, tournamentId)).length}명)\n`);
process.exit(0);
