import { IX } from "./state.js";

// 텍스트가 실제로 안 바뀌었으면 DOM을 다시 안 건드린다 — 이 함수를 부르는 쪽(tournament
// 문서 onSnapshot)은 공지 문구와 무관한 다른 필드가 바뀔 때도 매번 다시 호출하는데,
// textContent/animationDuration을 매번 같은 값으로 재대입해도 Safari에서는 흐르고 있던
// marquee 애니메이션이 처음부터 다시 시작돼(끊기고 다시 움직이는 것처럼 보임) 버린다.
let lastRenderedTopicText = null;

export function renderIndexTopicBar() {
  const text = String(IX.currentTournament?.topicText || "").trim();
  if (IX.topicBar) IX.topicBar.hidden = !text;
  if (text === lastRenderedTopicText) return;
  lastRenderedTopicText = text;
  if (IX.topicBarText) {
    IX.topicBarText.textContent = text;
    const seconds = Math.min(60, Math.max(14, text.length * 0.32));
    IX.topicBarText.style.animationDuration = `${seconds}s`;
  }
}
