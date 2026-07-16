/**
 * 특정 닉네임/uid global_waiting BLOCK 상태 진단 (읽기 전용)
 * node scripts/diagnose-waiting-block.mjs "이예은"
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const admin = require(
  join(dirname(fileURLToPath(import.meta.url)), "../functions/node_modules/firebase-admin")
);

const PROJECT_ID = "hanagency-c2c0e";
const queryName = String(process.argv[2] || "이예은").trim();

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function norm(s = "") {
  return String(s || "").trim();
}
function normLower(s = "") {
  return norm(s).toLowerCase();
}

function rowMatchesQuery(row = {}, name = "") {
  const q = norm(name);
  const qLower = normLower(name);
  const fields = [row.name, row.nickname, row.uid, row.email].map((v) => norm(v));
  return fields.some((f) => f === q || normLower(f) === qLower);
}

function summarizeWaitingRow(w = {}) {
  return {
    id: norm(w.id),
    name: norm(w.name),
    uid: norm(w.uid),
    email: norm(w.email),
    tournamentId: norm(w.tournamentId),
    blockChecked: w.blockChecked === true,
    blockCheckedAt: w.blockCheckedAt || null,
    blockAccumulatedMs: Number(w.blockAccumulatedMs || 0) || 0,
    joinedAt: w.joinedAt || w.createdAt || null,
    source: norm(w.source)
  };
}

console.log(`\n=== BLOCK 진단: "${queryName}" (project: ${PROJECT_ID}) ===\n`);

const waitingSnap = await db.doc("layout_shared/global_waiting").get();
const waitingData = waitingSnap.exists ? waitingSnap.data() || {} : {};
const waitingList = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
const matches = waitingList.filter((w) => rowMatchesQuery(w, queryName));

console.log(`[global_waiting] 전체 ${waitingList.length}행, "${queryName}" 매칭 ${matches.length}행`);
if (matches.length) {
  for (const w of matches) {
    console.log(JSON.stringify(summarizeWaitingRow(w), null, 2));
  }
} else {
  console.log("  (매칭 행 없음)");
}

const usersSnap = await db.collection("users").get();
const userMatches = [];
for (const d of usersSnap.docs) {
  const u = d.data() || {};
  const nick = norm(u.nickname);
  const email = norm(u.email);
  if (nick === queryName || normLower(nick) === normLower(queryName) || normLower(email).includes(normLower(queryName))) {
    userMatches.push({ uid: d.id, nickname: nick, email, name: norm(u.name) });
  }
}

console.log(`\n[users] "${queryName}" 매칭 ${userMatches.length}계정`);
for (const u of userMatches) {
  console.log(JSON.stringify(u, null, 2));

  const attSnap = await db.collection("dealer_attendance").where("uid", "==", u.uid).get();
  console.log(`  dealer_attendance ${attSnap.size}건`);
  for (const a of attSnap.docs) {
    const d = a.data() || {};
    console.log(
      JSON.stringify(
        {
          docId: a.id,
          tournamentId: norm(d.tournamentId),
          status: norm(d.status),
          nickname: norm(d.nickname || d.name),
          statusChangedAt: d.statusChangedAt || null,
          updatedAt: d.updatedAt || null
        },
        null,
        2
      )
    );
  }

  const byUid = waitingList.filter((w) => norm(w.uid) === u.uid);
  console.log(`  global_waiting uid 매칭 ${byUid.length}행`);
  for (const w of byUid) {
    console.log(JSON.stringify(summarizeWaitingRow(w), null, 2));
  }
}

const dupByUid = new Map();
for (const w of waitingList) {
  const uid = norm(w.uid);
  if (!uid) continue;
  if (!dupByUid.has(uid)) dupByUid.set(uid, []);
  dupByUid.get(uid).push(w);
}
const dups = [...dupByUid.entries()].filter(([, rows]) => rows.length > 1);
if (dups.length) {
  console.log(`\n[global_waiting] uid 중복 행 ${dups.length}명`);
  for (const [uid, rows] of dups) {
    const names = rows.map((r) => norm(r.name)).join(", ");
    const blocks = rows.map((r) => (r.blockChecked === true ? 1 : 0)).join(",");
    if (rows.some((r) => rowMatchesQuery(r, queryName) || userMatches.some((u) => u.uid === uid))) {
      console.log(`  uid=${uid} names=[${names}] block=[${blocks}]`);
      for (const w of rows) console.log("   ", JSON.stringify(summarizeWaitingRow(w)));
    }
  }
}

console.log("\n=== done ===\n");
