import { IX } from "./state.js";

export function renderIndexTopicBar() {
  const text = String(IX.currentTournament?.topicText || "").trim();
  if (IX.topicBar) IX.topicBar.hidden = !text;
  if (IX.topicBarText) {
    IX.topicBarText.textContent = text;
    const seconds = Math.min(60, Math.max(14, text.length * 0.32));
    IX.topicBarText.style.animationDuration = `${seconds}s`;
  }
}
