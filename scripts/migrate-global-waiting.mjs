/**
 * layout_shared/global_waiting (배열 하나) → tournaments/{tid}/global_waiting/{id} (문서별) 마이그레이션
 * 옛 문서는 삭제하지 않고 그대로 둔다 (롤백 안전망).
 *
 * 기본은 dry-run(쓰기 없이 계획만 출력). 실제로 쓰려면 --apply 플래그 필요.
 *   node scripts/migrate-global-waiting.mjs          (dry-run)
 *   node scripts/migrate-global-waiting.mjs --apply  (실제 반영)
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const PROJECT_ID = "hanagency-c2c0e";
const APPLY = process.argv.includes("--apply");

function setUpAdcFromFirebaseCli() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const cfgPath = join(homedir(), ".config/configstore/firebase-tools.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const refreshToken = cfg?.tokens?.refresh_token;
  if (!refreshToken) return;

  const adcPath = join(tmpdir(), "han-pit-firebase-cli-adc.json");
  writeFileSync(
    adcPath,
    JSON.stringify({
      client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
      client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
      refresh_token: refreshToken,
      type: "authorized_user"
    })
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
}

setUpAdcFromFirebaseCli();

const require = createRequire(import.meta.url);
const admin = require(
  join(dirname(fileURLToPath(import.meta.url)), "../functions/node_modules/firebase-admin")
);

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

function norm(s = "") {
  return String(s || "").trim();
}

console.log(`\n=== global_waiting 마이그레이션 (project: ${PROJECT_ID}, mode: ${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

const waitingSnap = await db.doc("layout_shared/global_waiting").get();
const waitingData = waitingSnap.exists ? waitingSnap.data() || {} : {};
const waitingList = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
const operatorPicks = waitingData.operatorPicks && typeof waitingData.operatorPicks === "object"
  ? waitingData.operatorPicks
  : {};

const skipped = [];
const rowsByTournament = new Map();

for (const row of waitingList) {
  const id = norm(row?.id);
  const tid = norm(row?.tournamentId);
  if (!id || !tid) {
    skipped.push(row);
    continue;
  }
  if (!rowsByTournament.has(tid)) rowsByTournament.set(tid, []);
  rowsByTournament.get(tid).push(row);
}

console.log(`대상: ${waitingList.length}행 중 ${waitingList.length - skipped.length}행 이관 예정, ${skipped.length}행 건너뜀(id/tournamentId 없음)`);
if (skipped.length) {
  console.log("건너뛴 행:", JSON.stringify(skipped, null, 2));
}

let writeCount = 0;
const batchLimit = 400;
let batch = db.batch();
let batchOps = 0;

async function flushBatch(force = false) {
  if (!batchOps) return;
  if (!force && batchOps < batchLimit) return;
  if (APPLY) await batch.commit();
  batch = db.batch();
  batchOps = 0;
}

for (const [tid, rows] of rowsByTournament) {
  console.log(`\n[${tid}] ${rows.length}행 이관`);
  for (const row of rows) {
    const id = norm(row.id);
    const { id: _drop, ...data } = row;
    const ref = db.doc(`tournaments/${tid}/global_waiting/${id}`);
    console.log(`  -> tournaments/${tid}/global_waiting/${id} (name=${norm(row.name)}, uid=${norm(row.uid)})`);
    if (APPLY) batch.set(ref, data, { merge: true });
    batchOps += 1;
    writeCount += 1;
    await flushBatch();
  }
}

const opsByTournament = new Map();
const opsSkipped = [];
for (const [uid, pick] of Object.entries(operatorPicks)) {
  const tid = norm(pick?.tournamentId);
  if (!tid) {
    opsSkipped.push(uid);
    continue;
  }
  if (!opsByTournament.has(tid)) opsByTournament.set(tid, {});
  opsByTournament.get(tid)[uid] = pick;
}

console.log(`\noperatorPicks: ${Object.keys(operatorPicks).length}건 중 ${opsSkipped.length}건 건너뜀(tournamentId 없음)`);
for (const [tid, picks] of opsByTournament) {
  const ref = db.doc(`tournaments/${tid}/global_waiting_meta/operatorPicks`);
  console.log(`  -> tournaments/${tid}/global_waiting_meta/operatorPicks (${Object.keys(picks).length}건)`);
  if (APPLY) batch.set(ref, { operatorPicks: picks, updatedAt: Date.now() }, { merge: true });
  batchOps += 1;
  await flushBatch();
}

await flushBatch(true);

console.log(`\n총 ${writeCount}개 대기 문서 ${APPLY ? "기록 완료" : "기록 예정(dry-run)"}, operatorPicks 문서 ${opsByTournament.size}개.`);
console.log(APPLY ? "\n=== 적용 완료 ===\n" : "\n=== dry-run 완료 (실제 반영하려면 --apply) ===\n");
