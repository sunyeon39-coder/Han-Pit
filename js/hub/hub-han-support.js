import { db, auth } from "../firebase.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import { closeModal, escapeHtml, openModal } from "../shared/dom-utils.js";
import { getIsAdminUser } from "./hub-helpers.js";

let unsubApplications = null;

/* ── 새 지원서 배지 (시스템 admin) ─────────────────────────────
 * HAN지원 버튼 오른쪽 위에 아이폰 앱 배지처럼 "확인 안 한 지원서 수"를 표시한다.
 * 마지막으로 지원서 창을 연 시각을 users/{uid}.hanApplicationsSeenAt 에 저장해
 * 폰·PC 어느 쪽에서 열어도 함께 지워진다.
 */
const HAN_BADGE_SCAN_LIMIT = 100;
let badgeUid = "";
let badgeSeenAt = 0;
let badgeLatestCreatedAts = [];
let stopBadgeAppsWatch = null;
let stopBadgeSeenWatch = null;

function renderHanSupportBadge(btn) {
  if (!btn) return;
  const count = badgeUid
    ? badgeLatestCreatedAts.filter((ms) => ms > badgeSeenAt).length
    : 0;
  let badge = btn.querySelector(".han-support-badge");
  if (!count) {
    badge?.remove();
    btn.removeAttribute("data-unread");
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "han-support-badge";
    badge.setAttribute("aria-hidden", "true");
    btn.appendChild(badge);
  }
  const label = count >= HAN_BADGE_SCAN_LIMIT ? "99+" : String(Math.min(count, 99));
  badge.textContent = label;
  btn.setAttribute("data-unread", label);
  btn.setAttribute("aria-label", `HAN지원 · 새 지원서 ${label}건`);
}

function stopHanSupportBadgeWatch(btn) {
  stopBadgeAppsWatch?.();
  stopBadgeSeenWatch?.();
  stopBadgeAppsWatch = null;
  stopBadgeSeenWatch = null;
  badgeUid = "";
  badgeLatestCreatedAts = [];
  renderHanSupportBadge(btn);
  btn?.setAttribute("aria-label", "HAN지원");
}

function startHanSupportBadgeWatch(user, btn) {
  if (!user?.uid || badgeUid === user.uid) return;
  stopHanSupportBadgeWatch(btn);
  badgeUid = user.uid;
  badgeSeenAt = 0;

  stopBadgeSeenWatch = onSnapshot(
    doc(db, "users", user.uid),
    (snap) => {
      badgeSeenAt = Number(snap.data()?.hanApplicationsSeenAt || 0) || 0;
      renderHanSupportBadge(btn);
    },
    (err) => console.warn("han badge seen watch:", err?.code || err)
  );
  stopBadgeAppsWatch = onSnapshot(
    query(collection(db, "han_applications"), orderBy("createdAt", "desc"), limit(HAN_BADGE_SCAN_LIMIT)),
    (snap) => {
      badgeLatestCreatedAts = snap.docs.map((d) => Number(d.data()?.createdAt || 0) || 0);
      renderHanSupportBadge(btn);
    },
    (err) => console.warn("han badge apps watch:", err?.code || err)
  );
}

/** 지원서 창을 열면 배지를 바로 지우고, 본 시각을 계정에 저장 */
function markHanApplicationsSeen(btn) {
  if (!badgeUid) return;
  const latest = Math.max(Date.now(), ...badgeLatestCreatedAts);
  badgeSeenAt = latest;
  renderHanSupportBadge(btn);
  void setDoc(doc(db, "users", badgeUid), { hanApplicationsSeenAt: latest }, { merge: true }).catch((err) =>
    console.warn("han badge mark seen:", err?.code || err)
  );
}

function getApplicantDisplayName(user, profile) {
  if (!user) return "";
  const nick = String(profile?.nickname || "").trim();
  if (nick) return nick;
  const dn = String(user.displayName || "").trim();
  if (dn) return dn;
  const em = String(user.email || "").trim();
  if (em) {
    const local = em.split("@")[0];
    if (local) return local;
  }
  return "";
}

function stopAdminApplicationsWatch() {
  if (unsubApplications) {
    unsubApplications();
    unsubApplications = null;
  }
}

function formatCreatedAt(ts) {
  if (ts == null || ts === "") return "";
  if (typeof ts.toDate === "function") {
    try {
      return ts.toDate().toLocaleString("ko-KR");
    } catch {
      return "";
    }
  }
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    return new Date(n).toLocaleString("ko-KR");
  }
  return "";
}

function renderAdminApplicationsList(listEl, docs) {
  if (!listEl) return;
  if (!docs.length) {
    listEl.innerHTML = `<div class="muted">아직 제출된 지원서가 없습니다.</div>`;
    return;
  }
  listEl.innerHTML = docs
    .map((d) => {
      const x = d.data() || {};
      const at = formatCreatedAt(x.createdAt);
      const uidShort = String(x.applicantUid || "").trim();
      const panelId = `han-app-panel-${String(d.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      return `
        <article class="han-app-accordion" data-han-doc="${escapeHtml(d.id)}">
          <button type="button" class="han-app-summary" aria-expanded="false" aria-controls="${escapeHtml(panelId)}">
            <span class="han-app-summary-main">
              <span class="han-app-summary-name">${escapeHtml(x.name)}</span>
              <span class="han-app-summary-meta muted">${escapeHtml(x.age)}세 · ${escapeHtml(x.gender)} · ${escapeHtml(x.phone)}</span>
            </span>
            <span class="han-app-summary-right">
              <span class="han-app-date muted">${escapeHtml(at)}</span>
              <span class="han-app-chevron" aria-hidden="true">▼</span>
            </span>
          </button>
          <div id="${escapeHtml(panelId)}" class="han-app-panel" role="region" hidden>
            <dl class="han-app-grid">
              <dt>나이</dt><dd>${escapeHtml(x.age)}</dd>
              <dt>성별</dt><dd>${escapeHtml(x.gender)}</dd>
              <dt>휴대폰</dt><dd>${escapeHtml(x.phone)}</dd>
              <dt>계정</dt><dd class="han-app-account">${escapeHtml(x.applicantEmail || "")}${uidShort ? ` <span class="muted">(${escapeHtml(uidShort)})</span>` : ""}</dd>
            </dl>
            <div class="han-app-experience">
              <div class="han-app-experience-label">경력</div>
              <div class="han-app-experience-body">${escapeHtml(x.experience)}</div>
            </div>
            <button type="button" class="btn danger han-app-delete-btn" data-han-delete="${escapeHtml(d.id)}">삭제하기</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function syncAdminSectionVisibility(hubRefs, hubState) {
  const wrap = hubRefs.hanSupportAdminWrap;
  if (!wrap) return false;
  const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
  if (isAdmin) {
    wrap.classList.remove("hidden");
    wrap.setAttribute("aria-hidden", "false");
  } else {
    wrap.classList.add("hidden");
    wrap.setAttribute("aria-hidden", "true");
  }
  return isAdmin;
}

/**
 * @returns {() => void} 정리용 (beforeunload 등)
 */
export function wireHanSupportHub({ hubRefs, hubState }) {
  const {
    hanSupportBtn,
    hanSupportModal,
    hanSupportCloseBtn,
    hanSupportForm,
    hanName,
    hanAge,
    hanGender,
    hanPhone,
    hanExperience,
    hanExperienceCount,
    hanSupportSubmitBtn,
    hanSupportAdminList
  } = hubRefs;

  function resetFormUi() {
    hanSupportForm?.reset();
    if (hanGender) hanGender.selectedIndex = 0;
    if (hanExperienceCount && hanExperience) {
      hanExperienceCount.textContent = String(hanExperience.value.length);
    }
  }

  function applyLockedApplicantName() {
    if (!hanName) return;
    const user = hubState.currentUser;
    const profile = hubState.currentUserProfile;
    hanName.value = getApplicantDisplayName(user, profile);
  }

  function openHanSupportModal() {
    syncAdminSectionVisibility(hubRefs, hubState);
    resetFormUi();
    applyLockedApplicantName();
    openModal(hanSupportModal);

    stopAdminApplicationsWatch();
    const isAdmin = getIsAdminUser(hubState.currentUser, hubState.currentUserProfile);
    if (isAdmin && hanSupportAdminList) {
      const q = query(collection(db, "han_applications"), orderBy("createdAt", "desc"));
      unsubApplications = onSnapshot(
        q,
        (snap) => {
          renderAdminApplicationsList(hanSupportAdminList, snap.docs);
        },
        (err) => {
          console.error("han_applications snapshot error:", err);
          const code = err?.code || err?.message || "error";
          hanSupportAdminList.innerHTML = `<div class="muted">지원 내역을 불러오지 못했습니다. (${escapeHtml(String(code))})</div>`;
        }
      );
    } else if (hanSupportAdminList) {
      hanSupportAdminList.innerHTML = "";
    }
  }

  function closeHanSupportModal() {
    stopAdminApplicationsWatch();
    closeModal(hanSupportModal);
  }

  hanSupportBtn?.addEventListener("click", () => {
    if (getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
      markHanApplicationsSeen(hanSupportBtn);
    }
    openHanSupportModal();
  });

  const stopBadgeAuthWatch = onAuthStateChanged(auth, (user) => {
    if (user && getIsAdminUser(user, null)) startHanSupportBadgeWatch(user, hanSupportBtn);
    else stopHanSupportBadgeWatch(hanSupportBtn);
  });

  hanSupportCloseBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closeHanSupportModal();
  });

  hanSupportModal?.addEventListener("click", (e) => {
    if (e.target === hanSupportModal) closeHanSupportModal();
  });

  hanExperience?.addEventListener("input", () => {
    if (hanExperienceCount) {
      hanExperienceCount.textContent = String(hanExperience.value.length);
    }
  });

  hanAge?.addEventListener("input", () => {
    const digits = String(hanAge.value || "").replace(/\D/g, "").slice(0, 3);
    hanAge.value = digits;
  });

  hanAge?.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const digits = text.replace(/\D/g, "").slice(0, 3);
    hanAge.value = digits;
  });

  function bindAdminApplicationsListUi() {
    if (!hanSupportAdminList || hanSupportAdminList.dataset.hanAccordionBound === "1") return;
    hanSupportAdminList.dataset.hanAccordionBound = "1";

    hanSupportAdminList.addEventListener("click", async (e) => {
      const delBtn = e.target.closest("[data-han-delete]");
      if (delBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (!getIsAdminUser(hubState.currentUser, hubState.currentUserProfile)) {
          alert("지원서 삭제는 시스템 admin만 가능합니다.");
          return;
        }
        const id = String(delBtn.getAttribute("data-han-delete") || "").trim();
        if (!id) return;
        if (!confirm("이 지원서를 삭제할까요? 삭제 후에는 복구할 수 없습니다.")) return;
        try {
          await deleteDoc(doc(db, "han_applications", id));
        } catch (err) {
          console.error("han application delete error:", err);
          alert("삭제에 실패했습니다.");
        }
        return;
      }

      const summary = e.target.closest(".han-app-summary");
      if (!summary) return;

      const row = summary.closest(".han-app-accordion");
      if (!row) return;

      const open = row.classList.toggle("is-open");
      summary.setAttribute("aria-expanded", open ? "true" : "false");
      const panel = row.querySelector(".han-app-panel");
      if (panel) panel.hidden = !open;
      if (open) {
        requestAnimationFrame(() => {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      }
    });
  }

  bindAdminApplicationsListUi();

  hanSupportForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = hubState.currentUser ?? auth.currentUser;
    if (!user) {
      alert("로그인을 확인하는 중입니다. 잠시 후 다시 시도해 주세요.");
      return;
    }

    const name = String(getApplicantDisplayName(user, hubState.currentUserProfile) || "").trim();
    const age = String(hanAge?.value || "").trim();
    const gender = String(hanGender?.value || "").trim();
    const phone = String(hanPhone?.value || "").trim();
    const experience = String(hanExperience?.value || "").trim();

    if (!name) {
      alert("표시할 이름이 없습니다. 프로필에서 닉네임을 설정한 뒤 다시 시도해 주세요.");
      return;
    }
    if (!age || !/^\d+$/.test(age)) {
      alert("나이는 숫자만 입력해 주세요.");
      return;
    }
    if (!gender || !phone) {
      alert("필수 항목을 모두 입력해 주세요.");
      return;
    }
    if (!experience) {
      alert("지원동기 및 경력 을 입력해 주세요. (150자 이내)");
      return;
    }
    if (experience.length > 150) {
      alert("경력은 150자 이내로 입력해 주세요.");
      return;
    }

    const submitBtn = hanSupportSubmitBtn;
    if (submitBtn) submitBtn.disabled = true;

    try {
      await addDoc(collection(db, "han_applications"), {
        applicantUid: user.uid,
        applicantEmail: String(user.email || "").trim(),
        name,
        age,
        gender,
        phone,
        experience,
        createdAt: Date.now()
      });
      alert("제출되었습니다.");
      resetFormUi();
      closeHanSupportModal();
    } catch (err) {
      console.error("han application submit error:", err);
      alert("제출에 실패했습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  return () => {
    stopAdminApplicationsWatch();
    stopBadgeAuthWatch();
    stopHanSupportBadgeWatch(hanSupportBtn);
  };
}
