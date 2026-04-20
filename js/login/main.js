import { auth, db } from "../firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { isAdminEmail } from "../app_config.js";
import { isAppDebugEnabled } from "../shared/app-debug.js";
import { syncUserProfile } from "./user-sync.js";

const googleBtn = document.getElementById("googleLogin");
const signupModal = document.getElementById("signupModal");
const signupConfirm = document.getElementById("signupConfirm");

const nicknameInput = document.getElementById("nicknameInput");
const phoneInput = document.getElementById("phoneInput");

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

const provider = new GoogleAuthProvider();
provider.setCustomParameters({
  prompt: "select_account"
});

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

  const profile = syncResult.profile || {};
  const nickname = String(profile.nickname || "").trim();

  if (!nickname || nickname.length < 2) {
    openSignupModal(profile);
    return;
  }

  location.href = "./hub.html";
}

async function login() {
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

getRedirectResult(auth)
  .then(async (result) => {
    if (result?.user) {
      await finalizeLoginFlow(result.user);
    }
  })
  .catch((error) => {
    console.error("redirect result error:", error);
    alert(`redirect result error: ${error?.code || ""} ${error?.message || error}`);
  });

googleBtn?.addEventListener("click", login);
signupConfirm?.addEventListener("click", saveProfile);
