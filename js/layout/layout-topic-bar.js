import { db } from "../firebase.js";
import {
  doc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * 일반 배치도(layout.html) 상단 공지(TOPIC) 배너.
 * 통합 배치도와 같은 tournaments/{tid}.topicText 를 실시간으로 읽어 "표시만" 한다.
 * (편집은 통합 배치도의 TOPIC 버튼에서 — 근무자 화면에서는 보기 전용)
 */
let activeUnsub = null;
let activeTid = "";

export function initLayoutTopicBar(tournamentId = "") {
  const tid = String(tournamentId || "").trim();
  const bar = document.getElementById("topicBar");
  const textEl = document.getElementById("topicBarText");
  if (!bar || !textEl) return;

  const apply = (raw) => {
    const text = String(raw || "").trim();
    document.body.classList.toggle("has-topic-bar", !!text);
    bar.hidden = !text;
    bar.setAttribute("aria-hidden", text ? "false" : "true");
    if (!text) return;
    textEl.textContent = text;
    // 통합 배치도와 동일한 흐름 속도 계산 (글자 수에 비례, 14~80초)
    const seconds = Math.min(80, Math.max(14, text.length * 0.32));
    textEl.style.animationDuration = `${seconds}s`;
  };

  if (activeUnsub && activeTid === tid) return;
  if (activeUnsub) {
    try {
      activeUnsub();
    } catch {
      /* noop */
    }
    activeUnsub = null;
  }
  activeTid = tid;

  apply("");
  if (!tid) return;

  activeUnsub = onSnapshot(
    doc(db, "tournaments", tid),
    (snap) => apply(snap.exists() ? snap.data()?.topicText : ""),
    (err) => console.error("layout topic bar snapshot error:", err)
  );
}
