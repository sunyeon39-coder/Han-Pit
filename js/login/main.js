import { auth, db } from "../firebase.js";
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { createGoogleAuthProvider } from "../shared/google-auth-provider.js";
import {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { resolveStoredUserRole } from "../shared/auth-helpers.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import {
  isValidNicknameLength,
  readCommittedNicknameInput
} from "../shared/nickname-validation.js";
import {
  syncUserProfile,
  syncUserProfileFast,
  scheduleBackgroundUserProfileSync
} from "./user-sync.js";
import {
  buildOptimisticProfileFromAuthUser,
  readLoginProfileCache,
  writeLoginProfileCache
} from "../shared/login-profile-cache.js";
import { loadUserProfileRevalidated } from "../shared/load-user-profile.js";
import { bootstrapAppPush } from "../shared/fcm-web-push.js";
import { prefetchHubTournamentsCache } from "../hub/hub-loaders-realtime.js";
import { syncUserDisplayNameAfterNicknameChange } from "../shared/sync-user-waiting-display.js";
import { instantDismissAllBootLoaders } from "../shared/page-boot-shell.js";
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

instantDismissAllBootLoaders();

const googleBtn = document.getElementById("googleLogin");
const signupModal = document.getElementById("signupModal");
const signupConfirm = document.getElementById("signupConfirm");
const loginBusyOverlay = document.getElementById("loginBusyOverlay");

const nicknameInput = document.getElementById("nicknameInput");
const phoneInput = document.getElementById("phoneInput");

const inAppGate = document.getElementById("inAppBrowserGate");
const openInChromeBtn = document.getElementById("openInChromeBtn");
const copyLoginUrlBtn = document.getElementById("copyLoginUrlBtn");

let selectedGender = "none";
let loginBusy = false;

function setLoginBusy(active) {
  loginBusy = !!active;
  if (googleBtn) {
    googleBtn.disabled = loginBusy;
    googleBtn.setAttribute("aria-busy", loginBusy ? "true" : "false");
  }
  loginBusyOverlay?.classList.add("hidden");
  loginBusyOverlay?.setAttribute("aria-hidden", "true");
}

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

function hasValidNickname(profile = null) {
  return isValidNicknameLength(profile?.nickname || "");
}

async function readUserDocSnapFromServer(uid) {
  const userRef = doc(db, "users", uid);
  try {
    return await getDocFromServer(userRef);
  } catch {
    return await getDoc(userRef);
  }
}

function scheduleLoginProfileBackgroundSync(user) {
  if (!user?.uid) return;
  scheduleBackgroundUserProfileSync(user);
  void (async () => {
    try {
      if (typeof auth.authStateReady === "function") {
        await auth.authStateReady();
      }
      if (user.getIdToken) {
        await user.getIdToken();
      }
      const email = user.email || "";
      const fast = await syncUserProfileFast(user);
      if (!fast.ok || !hasValidNickname(fast.profile)) {
        await syncUserProfile(user);
      }
      const fresh = await loadUserProfileRevalidated(user.uid, email);
      if (fresh) writeLoginProfileCache(user.uid, fresh);
    } catch (err) {
      console.warn("[login] background profile sync:", err);
    }
  })();
}

/** 캐시·Google displayName 만으로 즉시 허브 진입 — Firestore 동기화는 백그라운드 */
function resolveProfileForLoginInstant(user) {
  const profile = buildOptimisticProfileFromAuthUser(user, readLoginProfileCache(user.uid) || {});
  writeLoginProfileCache(user.uid, profile);
  scheduleLoginProfileBackgroundSync(user);
  return profile;
}

function redirectToHubImmediately() {
  void prefetchHubTournamentsCache();
  void bootstrapAppPush(auth.currentUser?.uid);
  location.replace("./hub.html");
}

function finalizeLoginFlow(user) {
  if (!user) return;

  setLoginBusy(false);

  const profile = resolveProfileForLoginInstant(user);

  if (isAppDebugEnabled()) {
    console.debug("[LOGIN FLOW]", {
      uid: user.uid,
      email: user.email || "",
      nickname: profile?.nickname,
      role: profile?.role
    });
  }

  if (!hasValidNickname(profile)) {
    openSignupModal(profile);
    return;
  }

  redirectToHubImmediately();
}

async function login() {
  if (loginBusy) return;

  if (isGoogleOAuthLikelyBlockedBrowser()) {
    alert(
      "이 환경에서는 Google 로그인을 사용할 수 없습니다.\n\n" +
        "화면 안내에 따라 Chrome(Android) 또는 Safari(iPhone)로 이 페이지를 다시 열어 주세요."
    );
    return;
  }

  setLoginBusy(true);

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
      setLoginBusy(false);
      alert(`로그인 이동 실패: ${redirectError?.code || ""} ${redirectError?.message || redirectError}`);
      return;
    }
  }

  try {
    const result = await signInWithPopup(auth, provider);
    finalizeLoginFlow(result.user);
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
        setLoginBusy(false);
        alert(`로그인 실패: ${redirectError?.code || ""} ${redirectError?.message || redirectError}`);
        return;
      }
    }

    setLoginBusy(false);
    alert(`로그인 실패: ${error?.code || ""} ${error?.message || error}`);
  }
}

async function saveProfile() {
  try {
    const nickname = readCommittedNicknameInput(nicknameInput);
    const phone = String(phoneInput?.value || "").trim();

    if (!isValidNicknameLength(nickname)) {
      alert("닉네임은 2~7자로 입력해주세요.");
      return;
    }

    if (!auth.currentUser) {
      alert("로그인 정보가 없습니다. 다시 시도해주세요.");
      return;
    }

    setLoginBusy(true);

    const user = auth.currentUser;
    const uid = user.uid;
    const email = String(user.email || "").trim().toLowerCase();
    const userRef = doc(db, "users", uid);
    const existingSnap = await readUserDocSnapFromServer(uid);
    const prev = existingSnap.exists() ? existingSnap.data() || {} : {};
    const role = resolveStoredUserRole(email, prev);

    const profile = {
      email: user.email || "",
      nickname,
      phone,
      gender: selectedGender,
      photoURL: String(user.photoURL || "").trim(),
      role,
      accessCode: String(prev.accessCode || "").trim(),
      allowedEvents: prev.allowedEvents && typeof prev.allowedEvents === "object" ? prev.allowedEvents : {}
    };

    const writePayload = {
      ...profile,
      lastLogin: serverTimestamp()
    };

    if (existingSnap.exists()) {
      const { role: _role, accessCode: _accessCode, allowedEvents: _allowedEvents, ...selfFields } =
        writePayload;
      await updateDoc(userRef, selfFields);
    } else {
      await setDoc(
        userRef,
        {
          ...writePayload,
          createdAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    writeLoginProfileCache(uid, profile);

    void syncUserDisplayNameAfterNicknameChange(uid, nickname).catch((syncErr) => {
      console.warn("[saveProfile] display name sync:", syncErr);
    });

    if (isAppDebugEnabled()) {
      console.debug("[PROFILE SAVED]", {
        uid: user.uid,
        email: user.email || "",
        role,
        nickname
      });
    }

    redirectToHubImmediately();
  } catch (error) {
    console.error("save profile error:", error);
    setLoginBusy(false);
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
      finalizeLoginFlow(user);
      return;
    }

    if (expectedRedirect) {
      user = await waitForSignedInUser(auth, 3000);
      clearOAuthRedirectPending();
      if (user) {
        finalizeLoginFlow(user);
      } else {
        setLoginBusy(false);
      }
    }
  } catch (error) {
    clearOAuthRedirectPending();
    setLoginBusy(false);
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
