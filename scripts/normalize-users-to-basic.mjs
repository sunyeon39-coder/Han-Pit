/**
 * users 컬렉션 정리 — app_config.js ADMIN_EMAILS 만 admin, 나머지는 role:user + allowedEvents 비움
 *
 * 실행: cd functions && npm install && cd .. && node scripts/normalize-users-to-basic.mjs
 * (firebase login 또는 GOOGLE_APPLICATION_CREDENTIALS 필요)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const admin = require(join(dirname(fileURLToPath(import.meta.url)), "../functions/node_modules/firebase-admin"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadAdminEmails() {
  const src = readFileSync(join(projectRoot, "js/app_config.js"), "utf8");
  const m = src.match(/ADMIN_EMAILS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].trim().toLowerCase());
}

const ADMIN_EMAILS = new Set(loadAdminEmails());
const PROJECT_ID = "hanagency-c2c0e";

function isSystemAdminEmail(email = "") {
  return ADMIN_EMAILS.has(String(email || "").trim().toLowerCase());
}

function sanitizeAllowedEvents(allowedEvents = {}) {
  const out = {};
  for (const [key, value] of Object.entries(allowedEvents || {})) {
    const id = String(key || "").trim();
    if (id && value === true) out[id] = true;
  }
  return out;
}

function shouldDemote(data = {}, email = "") {
  if (isSystemAdminEmail(email)) return false;
  const role = String(data.role || "").trim().toLowerCase();
  const allowed = sanitizeAllowedEvents(data.allowedEvents);
  return role === "admin" || Object.keys(allowed).length > 0;
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const snap = await db.collection("users").get();
const plan = [];

for (const docSnap of snap.docs) {
  const data = docSnap.data() || {};
  const email = String(data.email || "").trim().toLowerCase();
  const uid = docSnap.id;

  if (isSystemAdminEmail(email)) {
    if (String(data.role || "").trim() !== "admin") {
      plan.push({ uid, email, action: "promote_system_admin", before: { role: data.role } });
    }
    continue;
  }

  if (shouldDemote(data, email)) {
    plan.push({
      uid,
      email: email || "(no email)",
      nickname: String(data.nickname || "").trim(),
      action: "demote_to_user",
      before: {
        role: data.role,
        allowedEvents: sanitizeAllowedEvents(data.allowedEvents)
      }
    });
  }
}

console.log(`\n총 users: ${snap.size}`);
console.log(`정리 대상: ${plan.length}\n`);

if (!plan.length) {
  console.log("변경할 문서가 없습니다.");
  process.exit(0);
}

for (const row of plan) {
  console.log(
    `- ${row.action} | ${row.email} | ${row.uid}` +
      (row.before?.role ? ` | role=${row.before.role}` : "") +
      (row.before?.allowedEvents && Object.keys(row.before.allowedEvents).length
        ? ` | allowedEvents=${JSON.stringify(row.before.allowedEvents)}`
        : "")
  );
}

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("\n--dry-run: Firestore 쓰기 생략");
  process.exit(0);
}

let ok = 0;
let fail = 0;
const batchSize = 400;
let batch = db.batch();
let n = 0;

async function commitBatch() {
  if (n === 0) return;
  await batch.commit();
  ok += n;
  batch = db.batch();
  n = 0;
}

for (const row of plan) {
  const ref = db.collection("users").doc(row.uid);
  if (row.action === "promote_system_admin") {
    batch.set(ref, { role: "admin" }, { merge: true });
  } else {
    batch.set(
      ref,
      {
        role: "user",
        allowedEvents: {}
      },
      { merge: true }
    );
  }
  n += 1;
  if (n >= batchSize) await commitBatch();
}

await commitBatch();

console.log(`\n완료: ${ok}건 갱신, 실패 ${fail}건`);
