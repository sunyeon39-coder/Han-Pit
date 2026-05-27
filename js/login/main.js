import { auth, db } from "../firebase.js";
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { createGoogleAuthProvider } from "../shared/google-auth-provider.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isAdminEmail } from "../app_config.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { syncUserProfile } from "./user-sync.js";
import { refreshFcmTokenIfGranted } from "../shared/fcm-web-push.js";
import {
  isGoogleOAuthLikelyBlockedBrowser,
  shouldPreferGoogleRedirectOverPopup,
  markOAuthRedirectPending,
  clearOAuthRedirectPending,
  isOAuthRedirectPending,
  openCurrentUrlInAndroidChrome,
  openCurrentUrlInIosSystemSafari,
  copyCurrentUrlToClipboard
} from "../shared/google-oauth-environment.js";

const googleBtn = document.getElementById("googleLogin");
const signupModal = document.getElementById("signupModal");
const signupConfirm = document.getElementById("signupConfirm");

const nicknameInput = document.getElementById("nicknameInput");
const phoneInput = document.getElementById("phoneInput");

const inAppGate = document.getElementById("inAppBrowserGate");
const openInChromeBtn = document.getElementById("openInChromeBtn");
const copyLoginUrlBtn = document.getElementById("copyLoginUrlBtn");

let selectedGender = "none";

function openSignupModal(profile = null) {
  if (nicknameInput) {
    nicknameInput.value = String(profile?.nickname || "").trim();
  }

  if (phoneInput) {
    phoneInput.value = String(profile?.phone || "").trim();
  }

  selectedGender = String(profile?.gender || "none").trim() || "none";

  document.querySelectorAll(".gender-btn").forEach((btn) => {
    const gender = String(btn.dataset.gender || "none").trim();
    btn.classList.toggle("active", gender === selectedGender);
  });

  signupModal?.classList.remove("hidden");
}

document.querySelectorAll(".gender-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".gender-btn").forEach((b) => {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    selectedGender = btn.dataset.gender || "none";
  });
});

const provider = createGoogleAuthProvider();

function wireInAppBrowserGate() {
  if (!isGoogleOAuthLikelyBlockedBrowser()) return;

  inAppGate?.classList.remove("hidden");
  if (googleBtn) {
    googleBtn.disabled = true;
    googleBtn.setAttribute("aria-disabled", "true");
  }

  openInChromeBtn?.addEventListener("click", () => {
    const s = navigator.userAgent || "";
    if (/Android/i.test(s)) openCurrentUrlInAndroidChrome();
    else if (/iPhone|iPad|iPod/i.test(s)) openCurrentUrlInIosSystemSafari();
    else window.open(location.href, "_blank", "noopener,noreferrer");
  });
  copyLoginUrlBtn?.addEventListener("click", async () => {
    const ok = await copyCurrentUrlToClipboard();
    alert(
      ok
        ? "주소를 복사했습니다. Chrome 또는 Safari 주소창에 붙여넣기 해 주세요."
        : "복사에 실패했습니다. 주소창의 URL을 직접 선택해 복사해 주세요."
    );
  });
}

wireInAppBrowserGate();

async function finalizeLoginFlow(user) {
  if (!user) return;

  const syncResult = await syncUserProfile(user);

  if (isAppDebugEnabled()) {
    console.debug("[LOGIN FLOW]", {
      uid: user.uid,
      email: user.email || "",
      syncResult,
      isAdminEmail: isAdminEmail(user.email || "")
    });
  }

  if (!syncResult.ok) {
    alert(
      "구글 로그인은 성공했지만 프로필 동기화에 실패했습니다.\n" +
        "대부분 Firestore Rules 또는 users 문서 권한 문제입니다.\n\n" +
        `에러: ${syncResult.error?.message || syncResult.error || "unknown"}`
    );
    return;
  }

  void refreshFcmTokenIfGranted(user.uid);

  const profile = syncResult.profile || {};
  const nickname = String(profile.nickname || "").trim();

  if (!nickname || nickname.length < 2) {
    openSignupModal(profile);
    return;
  }

  location.href = "./hub.html";
}

async function login() {
  if (isGoogleOAuthLikelyBlockedBrowser()) {
    alert(
      "이 환경에서는 Google 로그인을 사용할 수 없습니다.\n\n" +
        "화면 안내에 따라 Chrome(Android) 또는 Safari(iPhone)로 이 페이지를 다시 열어 주세요."
    );
    return;
  }

  if (auth.currentUser) {
    try {
      await signOut(auth);
    } catch (signOutErr) {
      console.warn("login pre-signOut:", signOutErr);
    }
  }

  if (shouldPreferGoogleRedirectOverPopup()) {
    try {
      markOAuthRedirectPending();
      await signInWithRedirect(auth, provider);
      return;
    } catch (redirectError) {
      console.error("login redirect (primary) error:", redirectError);
      alert(`로그인 이동 실패: ${redirectError?.code || ""} ${redirectError?.message || redirectError}`);
      return;
    }
  }

  try {
    const result = await signInWithPopup(auth, provider);
    await finalizeLoginFlow(result.user);
  } catch (error) {
    console.error("login popup error:", error);

    const fallbackCodes = [
      "auth/popup-blocked",
      "auth/popup-closed-by-user",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment"
    ];

    if (fallbackCodes.includes(error?.code)) {
      try {
        markOAuthRedirectPending();
        await signInWithRedirect(auth, provider);
        return;
      } catch (redirectError) {
        console.error("login redirect error:", redirectError);
        alert(`로그인 실패: ${redirectError?.code || ""} ${redirectError?.message || redirectError}`);
        return;
      }
    }

    alert(`로그인 실패: ${error?.code || ""} ${error?.message || error}`);
  }
}

async function saveProfile() {
  try {
    const nickname = String(nicknameInput?.value || "").trim();
    const phone = String(phoneInput?.value || "").trim();

    if (nickname.length < 2 || nickname.length > 7) {
      alert("닉네임은 2~7자로 입력해주세요.");
      return;
    }

    if (!auth.currentUser) {
      alert("로그인 정보가 없습니다. 다시 시도해주세요.");
      return;
    }

    const user = auth.currentUser;
    const uid = user.uid;
    const email = String(user.email || "").trim().toLowerCase();
    const role = isAdminEmail(email) ? "admin" : "user";

    await setDoc(
      doc(db, "users", uid),
      {
        email: user.email || "",
        nickname,
        phone,
        gender: selectedGender,
        photoURL: String(user.photoURL || "").trim(),
        role,
        lastLogin: serverTimestamp()
      },
      { merge: true }
    );

    if (isAppDebugEnabled()) {
      console.debug("[PROFILE SAVED]", {
        uid: user.uid,
        email: user.email || "",
        role,
        nickname
      });
    }

    location.href = "./hub.html";
  } catch (error) {
    console.error("save profile error:", error);
    alert(`회원 정보 저장 실패: ${error?.message || error}`);
  }
}

function waitForSignedInUser(authInstance, timeoutMs) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      try {
        unsub();
      } catch (_) {}
      resolve(authInstance.currentUser);
    }, timeoutMs);
    const unsub = onAuthStateChanged(authInstance, (u) => {
      if (!u) return;
      window.clearTimeout(timer);
      try {
        unsub();
      } catch (_) {}
      resolve(u);
    });
  });
}

/**
 * signInWithRedirect 복귀 후 처리.
 * getRedirectResult → authStateReady → currentUser 순으로 보고,
 * GitHub Pages+서드파티 저장소 제한으로 비어 있으면 onAuthStateChanged 로 잠시 대기한다.
 */
async function consumeGoogleRedirectResult() {
  const expectedRedirect = isOAuthRedirectPending();
  try {
    let cred = null;
    try {
      cred = await getRedirectResult(auth);
    } catch (e) {
      const c = String(e?.code || "");
      if (c && c !== "auth/no-auth-event") throw e;
    }

    if (typeof auth.authStateReady === "function") {
      await auth.authStateReady();
    }

    let user = cred?.user || auth.currentUser;
    if (user) {
      clearOAuthRedirectPending();
      await finalizeLoginFlow(user);
      return;
    }

    if (expectedRedirect) {
      user = await waitForSignedInUser(auth, 5000);
      clearOAuthRedirectPending();
      if (user) {
        await finalizeLoginFlow(user);
      }
    }
  } catch (error) {
    clearOAuthRedirectPending();
    const code = String(error?.code || "");
    if (!code || code === "auth/no-auth-event") return;
    console.error("redirect result error:", error);
    const hint =
      /disallowed|403|useragent/i.test(String(error?.message || "")) ||
      code === "auth/operation-not-allowed"
        ? "\n\nChrome 또는 Safari에서 다시 시도해 주세요. 카카오톡 등 인앱 브라우저는 사용할 수 없습니다."
        : "";
    alert(`로그인 처리 오류: ${code} ${error?.message || ""}${hint}`);
  }
}

void consumeGoogleRedirectResult();

googleBtn?.addEventListener("click", login);
signupConfirm?.addEventListener("click", saveProfile);
