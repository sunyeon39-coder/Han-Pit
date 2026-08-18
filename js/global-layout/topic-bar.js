import { db } from "../firebase.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { GL } from "./state.js";
import { canManageGlobalLayoutOps } from "./ops-access.js";

export function initGlobalLayoutTopicBarDom() {
  GL.topicEditBtn?.addEventListener("click", () => void editGlobalLayoutTopic());
}

export function renderGlobalLayoutTopicBar() {
  const text = String(GL.topicText || "").trim();
  document.body.classList.toggle("has-topic-bar", !!text);
  if (GL.topicBar) GL.topicBar.hidden = !text;
  if (GL.topicBarText) {
    GL.topicBarText.textContent = text;
    const seconds = Math.min(60, Math.max(10, text.length * 0.22));
    GL.topicBarText.style.animationDuration = `${seconds}s`;
  }
}

async function editGlobalLayoutTopic() {
  if (!canManageGlobalLayoutOps() || !GL.tournamentId) return;
  const next = prompt("공지 문구를 입력하세요 (비워두면 배너가 사라집니다)", GL.topicText || "");
  if (next === null) return;
  const trimmed = next.trim();
  if (trimmed === String(GL.topicText || "").trim()) return;
  try {
    await setDoc(doc(db, "tournaments", GL.tournamentId), { topicText: trimmed }, { merge: true });
    GL.topicText = trimmed;
    renderGlobalLayoutTopicBar();
  } catch (err) {
    console.error("topic bar update error:", err);
    alert("공지 문구 저장에 실패했습니다.");
  }
}
