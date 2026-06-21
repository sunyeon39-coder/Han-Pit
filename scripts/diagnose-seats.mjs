/**
 * 좌석/레이아웃 데이터 진단 (읽기 전용) — 무엇이 살아있고 무엇이 사라졌는지 스캔합니다.
 *
 * 무엇을 보나:
 *  - tournaments/{tid}                  : 대회 문서(공백 ID 등 확인)
 *  - tournaments/{tid}/global_seats     : 통합배치도 좌석(총/배치됨)
 *  - layout_events/{docId}              : 개별 배치도 원본 좌석(총/배치됨) — global_seats 복구 소스
 *  - users                              : 유저 수
 *  - layout_shared/global_waiting       : 대기열
 *
 * 실행:
 *   cd functions && npm install && cd ..
 *   firebase login   (또는 export GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json)
 *   node scripts/diagnose-seats.mjs
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

function isEmptyPerson(person = "") {
  return EMPTY_PERSON.has(String(person || "").trim());
}

function countSeats(seats = []) {
  const arr = Array.isArray(seats) ? seats : [];
  let occupied = 0;
  for (const s of arr) {
    if (!isEmptyPerson(s?.person)) occupied += 1;
  }
  return { total: arr.length, occupied };
}

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

console.log(`\n=== Firestore 진단 (project: ${PROJECT_ID}) ===\n`);

// 1) tournaments + 각 대회의 global_seats
const tournamentsSnap = await db.collection("tournaments").get();
console.log(`[tournaments] 문서 ${tournamentsSnap.size}개`);

let totalGlobalSeats = 0;
let totalGlobalOccupied = 0;

for (const t of tournamentsSnap.docs) {
  const tdata = t.data() || {};
  const seatsSnap = await db.collection("tournaments").doc(t.id).collection("global_seats").get();
  let occupied = 0;
  let managed = 0;
  for (const s of seatsSnap.docs) {
    const d = s.data() || {};
    if (!isEmptyPerson(d.person)) occupied += 1;
    if (d.managedByLayoutSync === true) managed += 1;
  }
  totalGlobalSeats += seatsSnap.size;
  totalGlobalOccupied += occupied;
  console.log(
    `  - "${t.id}" (name=${JSON.stringify(tdata.name || "")}) ` +
      `global_seats=${seatsSnap.size} (배치됨 ${occupied}, layout동기화 ${managed})`
  );
}

console.log(
  `\n[global_seats 합계] 좌석 ${totalGlobalSeats}개, 배치됨 ${totalGlobalOccupied}개\n`
);

// 2) layout_events (global_seats 복구 소스)
const layoutSnap = await db.collection("layout_events").get();
console.log(`[layout_events] 문서 ${layoutSnap.size}개 (개별 배치도 원본)`);

let totalLayoutSeats = 0;
let totalLayoutOccupied = 0;

for (const e of layoutSnap.docs) {
  const d = e.data() || {};
  const { total, occupied } = countSeats(d.seats);
  totalLayoutSeats += total;
  totalLayoutOccupied += occupied;
  if (total > 0 || occupied > 0) {
    console.log(
      `  - "${e.id}" tid=${JSON.stringify(d.tournamentId || "")} ` +
        `eventId=${JSON.stringify(d.eventId || "")} boxId=${JSON.stringify(d.boxId || "")} ` +
        `seats=${total} (배치됨 ${occupied}) updatedAt=${d.updatedAt || 0}`
    );
  }
}

console.log(
  `\n[layout_events 합계] 좌석 ${totalLayoutSeats}개, 배치됨 ${totalLayoutOccupied}개\n`
);

// 3) users
const usersSnap = await db.collection("users").get();
console.log(`[users] 문서 ${usersSnap.size}개`);

// 4) global_waiting
try {
  const waitingSnap = await db.collection("layout_shared").doc("global_waiting").get();
  const waiting = waitingSnap.exists ? waitingSnap.data()?.waiting : null;
  console.log(`[global_waiting] 대기 ${Array.isArray(waiting) ? waiting.length : 0}명`);
} catch (err) {
  console.log(`[global_waiting] 읽기 실패: ${err?.code || err}`);
}

// 5) 결론 힌트
console.log("\n=== 해석 ===");
if (totalGlobalSeats === 0 && totalLayoutSeats === 0) {
  console.log(
    "global_seats 와 layout_events 둘 다 비어 있음 → 원본까지 삭제됨. 코드 재투영으로는 복구 불가, Firebase 백업/PITR 필요."
  );
} else if (totalGlobalSeats === 0 && totalLayoutSeats > 0) {
  console.log(
    "global_seats 만 비고 layout_events 원본은 살아있음 → 재투영 복구 가능! recover-seats 스크립트로 되살릴 수 있음."
  );
} else {
  console.log(
    "global_seats 에 데이터가 있음 → 앱이 다른 tournamentId 를 읽고 있을 가능성(고아 데이터). 위 대회 ID 목록과 앱에서 쓰는 ID 를 비교하세요."
  );
}
console.log("");
process.exit(0);
