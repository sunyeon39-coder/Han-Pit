/**
 * global_waiting 문서 분산 마이그레이션 사전 점검 (읽기 전용)
 * node scripts/preflight-global-waiting-migration.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const PROJECT_ID = "hanagency-c2c0e";

// gcloud ADC가 없는 환경 — firebase CLI가 로그인 시 저장해둔 refresh token을
// gcloud ADC와 동일한 형식(authorized_user)의 임시 파일로 써서 표준 ADC 경로로 사용한다.
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

console.log(`\n=== global_waiting 마이그레이션 사전 점검 (project: ${PROJECT_ID}) ===\n`);

const waitingSnap = await db.doc("layout_shared/global_waiting").get();
const waitingData = waitingSnap.exists ? waitingSnap.data() || {} : {};
const waitingList = Array.isArray(waitingData.waiting) ? waitingData.waiting : [];
const operatorPicks = waitingData.operatorPicks && typeof waitingData.operatorPicks === "object"
  ? waitingData.operatorPicks
  : {};

console.log(`[global_waiting] 총 ${waitingList.length}행, operatorPicks ${Object.keys(operatorPicks).length}건\n`);

const byTournament = new Map();
const noTournamentId = [];
const dupIds = new Map();

for (const row of waitingList) {
  const id = norm(row?.id);
  const tid = norm(row?.tournamentId);

  if (id) {
    if (!dupIds.has(id)) dupIds.set(id, []);
    dupIds.get(id).push(row);
  }

  if (!tid) {
    noTournamentId.push(row);
    continue;
  }
  if (!byTournament.has(tid)) byTournament.set(tid, []);
  byTournament.get(tid).push(row);
}

console.log(`[대회별 분포] ${byTournament.size}개 대회`);
for (const [tid, rows] of byTournament) {
  console.log(`  tournamentId=${tid}: ${rows.length}행`);
}

console.log(`\n[tournamentId 없는 레거시 행] ${noTournamentId.length}건`);
for (const row of noTournamentId.slice(0, 50)) {
  console.log("  ", JSON.stringify({
    id: norm(row?.id),
    name: norm(row?.name),
    uid: norm(row?.uid),
    email: norm(row?.email),
    source: norm(row?.source)
  }));
}
if (noTournamentId.length > 50) {
  console.log(`  ... 외 ${noTournamentId.length - 50}건 생략`);
}

const dupEntries = [...dupIds.entries()].filter(([, rows]) => rows.length > 1);
console.log(`\n[id 중복 행] ${dupEntries.length}건 (같은 id가 여러 번 등장 — 마이그레이션 시 마지막 값으로 덮어써짐)`);
for (const [id, rows] of dupEntries.slice(0, 30)) {
  console.log(`  id=${id}: ${rows.length}회, tournamentIds=[${rows.map((r) => norm(r?.tournamentId)).join(", ")}]`);
}

console.log("\n[operatorPicks 대회별 분포]");
const opByTournament = new Map();
const opNoTournament = [];
for (const [uid, pick] of Object.entries(operatorPicks)) {
  const tid = norm(pick?.tournamentId);
  if (!tid) {
    opNoTournament.push(uid);
    continue;
  }
  if (!opByTournament.has(tid)) opByTournament.set(tid, []);
  opByTournament.get(tid).push(uid);
}
for (const [tid, uids] of opByTournament) {
  console.log(`  tournamentId=${tid}: ${uids.length}건`);
}
console.log(`  tournamentId 없음: ${opNoTournament.length}건 (${opNoTournament.join(", ")})`);

console.log("\n=== done ===\n");
