import { auth, db } from "../firebase.js";
import {
  doc,
  deleteField,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { resolveLayoutAccentColor } from "../shared/layout-operator-colors.js";
import { GL } from "./state.js";
import { escapeHtml } from "./utils.js";

const WAITING_REF = () => doc(db, "layout_shared", "global_waiting");

export function getOperatorDisplayName(profile = {}, user = null) {
  const nick = String(profile?.nickname || "").trim();
  if (nick) return nick;
  const dn = String(user?.displayName || "").trim();
  if (dn) return dn;
  const em = String(user?.email || profile?.email || "").trim();
  if (em) {
    const local = em.split("@")[0];
    if (local) return local;
  }
  const uid = String(user?.uid || "").trim();
  return uid ? uid.slice(0, 8) : "운영";
}

export function applyOperatorPicksFromDoc(data = {}) {
  const raw = data?.operatorPicks;
  GL.operatorPicks = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  syncSelectedWaitingFromMyOperatorPick();
}

/** Firestore operatorPicks 와 패널 selectedWaitingId 를 맞춤 (한 번만 눌러도 배치 가능) */
export function syncSelectedWaitingFromMyOperatorPick() {
  const myUid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
  if (!myUid) return;
  const mine = GL.operatorPicks?.[myUid];
  const pickWid = mine?.waitingId ? String(mine.waitingId).trim() : "";
  const cur = String(GL.selectedWaitingId || "").trim();
  if (pickWid && !cur) {
    GL.selectedWaitingId = pickWid;
  }
}

/** Firestore 반영 전 로컬에 내 선택을 즉시 표시 */
export function applyOptimisticMyWaitingPick(waitingId = "") {
  const uid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
  if (!uid || !GL.isAdminUser) return;
  const wid = String(waitingId || "").trim();
  if (!wid) {
    const next = { ...(GL.operatorPicks || {}) };
    delete next[uid];
    GL.operatorPicks = next;
    return;
  }
  GL.operatorPicks = {
    ...(GL.operatorPicks || {}),
    [uid]: {
      waitingId: wid,
      tournamentId: String(GL.tournamentId || "").trim(),
      displayName: getOperatorDisplayName(GL.userProfile, GL.currentUser),
      color: GL.layoutAccentColor,
      updatedAt: Date.now()
    }
  };
}

/** 대기 행 선택 — 토글 해제 없이 한 번에 선택 + 운영자 pick 동기화 */
export function setWaitingRowSelection(waitingId = "") {
  const wid = String(waitingId || "").trim();
  GL.selectedWaitingId = wid;
  if (wid && GL.selectedSeatIds?.clear) GL.selectedSeatIds.clear();
  applyOptimisticMyWaitingPick(wid);
  void syncMyWaitingPick(wid);
}

export function getActiveOperatorPicks() {
  const tid = String(GL.tournamentId || "").trim();
  const myUid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
  const list = [];

  for (const [uid, pick] of Object.entries(GL.operatorPicks || {})) {
    if (!pick || typeof pick !== "object") continue;
    const waitingId = String(pick.waitingId || "").trim();
    if (!waitingId) continue;
    const pickTid = String(pick.tournamentId || "").trim();
    if (pickTid && tid && pickTid !== tid) continue;
    list.push({
      uid,
      waitingId,
      displayName: String(pick.displayName || "").trim() || uid.slice(0, 6),
      color: String(pick.color || "").trim() || resolveLayoutAccentColor({}, uid),
      isSelf: uid === myUid
    });
  }

  return list;
}

export function getWaitingRowPickState(waitingId = "") {
  const wid = String(waitingId || "").trim();
  const myUid = String(GL.currentUser?.uid || "").trim();
  const onRow = getActiveOperatorPicks().filter((p) => p.waitingId === wid);
  const selfPick = onRow.find((p) => p.uid === myUid);
  const others = onRow.filter((p) => p.uid !== myUid);
  const primary = selfPick || others[0] || null;

  return {
    selfPick,
    others,
    primaryColor: primary?.color || GL.layoutAccentColor || "#4DA3FF",
    hasRemote: others.length > 0
  };
}

export function buildOperatorLegendHtml() {
  const picks = getActiveOperatorPicks();
  if (!picks.length) return "";

  const chips = picks
    .map((p) => {
      const label = p.isSelf ? `${escapeHtml(p.displayName)} (나)` : escapeHtml(p.displayName);
      return `<span class="gl-operator-chip" style="--op-color:${escapeHtml(p.color)}" title="대기 선택 중">${label}</span>`;
    })
    .join("");

  return `
    <div class="gl-operator-legend" aria-label="운영자 선택 표시">
      <span class="gl-operator-legend-title">운영 선택</span>
      ${chips}
    </div>
  `;
}

export function buildWaitingPickBadgesHtml(waitingId = "") {
  const { selfPick, others } = getWaitingRowPickState(waitingId);
  const parts = [];

  if (selfPick) {
    parts.push(
      `<span class="wait-pick-badge wait-pick-badge--self" style="--pick-color:${escapeHtml(selfPick.color)}">내 선택</span>`
    );
  }
  for (const p of others) {
    parts.push(
      `<span class="wait-pick-badge" style="--pick-color:${escapeHtml(p.color)}">${escapeHtml(p.displayName)} 선택</span>`
    );
  }

  return parts.length ? `<span class="wait-pick-badges">${parts.join("")}</span>` : "";
}

export async function syncMyWaitingPick(waitingId = "") {
  const uid = String(GL.currentUser?.uid || auth.currentUser?.uid || "").trim();
  if (!uid || !GL.isAdminUser) return;

  const wid = String(waitingId || "").trim();
  try {
    if (!wid) {
      await updateDoc(WAITING_REF(), { [`operatorPicks.${uid}`]: deleteField() });
      return;
    }
    await updateDoc(WAITING_REF(), {
      [`operatorPicks.${uid}`]: {
        waitingId: wid,
        tournamentId: String(GL.tournamentId || "").trim(),
        displayName: getOperatorDisplayName(GL.userProfile, GL.currentUser),
        color: GL.layoutAccentColor,
        updatedAt: Date.now()
      }
    });
  } catch (err) {
    console.warn("syncMyWaitingPick:", err?.code || err);
  }
}

export async function clearMyWaitingPick() {
  await syncMyWaitingPick("");
}

export function waitingRowPickClass(waitingId = "", selected = false) {
  const wid = String(waitingId || "").trim();
  const cur = String(GL.selectedWaitingId || "").trim();
  const isSelected = selected || (wid && cur === wid);
  const { primaryColor, hasRemote, selfPick } = getWaitingRowPickState(waitingId);
  const classes = [];
  if (isSelected || selfPick) classes.push("is-operator-pick-self");
  if (hasRemote) classes.push("has-operator-pick-remote");
  return { classes: classes.join(" "), pickColor: primaryColor, isSelected };
}
