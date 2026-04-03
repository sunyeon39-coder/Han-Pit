import { auth, db } from "./firebase.js";

import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const googleBtn = document.getElementById("googleLogin");
const signupModal = document.getElementById("signupModal");
const signupConfirm = document.getElementById("signupConfirm");

const nicknameInput = document.getElementById("nicknameInput");
const phoneInput = document.getElementById("phoneInput");

let selectedGender = "none";

const ADMIN_EMAILS = [
  "sunyeon9501@gmail.com"
  // "SECOND_ADMIN_EMAIL@gmail.com"
];

function isAdminEmail(email = "") {
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
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

const provider = new GoogleAuthProvider();
provider.setCustomParameters({
  prompt: "select_account"
});

async function ensureUserDoc(user) {
  if (!user) return null;

  const uid = user.uid;
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);

  const email = String(user.email || "").trim().toLowerCase();
  const role = isAdminEmail(email) ? "admin" : "user";

  if (!snap.exists()) {
    await setDoc(
      userRef,
      {
        email: user.email || "",
        nickname: String(user.displayName || "").trim(),
        phone: "",
        gender: "none",
        role,
        accessCode: "",
        allowedEvents: {},
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp()
      },
      { merge: true }
    );

    return { created: true, role };
  }

  await updateDoc(userRef, {
    email: user.email || "",
    lastLogin: serverTimestamp()
  });

  return { created: false, role };
}

async function ensureUserRole(user) {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  const email = String(user.email || "").trim().toLowerCase();
  const shouldBeAdmin = isAdminEmail(email);

  if (!snap.exists()) return;

  const data = snap.data() || {};
  const currentRole = String(data.role || "user").trim();
  const nextRole = shouldBeAdmin ? "admin" : "user";

  if (currentRole !== nextRole) {
    await updateDoc(userRef, {
      role: nextRole,
      email: user.email || "",
      lastLogin: serverTimestamp()
    });
  } else {
    await updateDoc(userRef, {
      email: user.email || "",
      lastLogin: serverTimestamp()
    });
  }
}

async function handleLoggedInUser(user) {
  if (!user) return;

  const uid = user.uid;
  const userRef = doc(db, "users", uid);

  await ensureUserDoc(user);
  await ensureUserRole(user);

  const snap = await getDoc(userRef);
  const data = snap.exists() ? (snap.data() || {}) : null;

  console.log("[LOGIN OK]", {
    uid: user.uid,
    email: user.email || "",
    hasProfile: snap.exists(),
    profile: data,
    isAdminEmail: isAdminEmail(user.email || "")
  });

  const nickname = String(data?.nickname || "").trim();

  // users 문서는 이미 생성된 상태에서 추가 정보만 보완
  if (!nickname || nickname.length < 2) {
    openSignupModal(data);
    return;
  }

  location.href = "./hub.html";
}

async function login() {
  try {
    const result = await signInWithPopup(auth, provider);
    await handleLoggedInUser(result.user);
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
        alert("로그인 실패");
        return;
      }
    }

    alert("로그인 실패");
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
        role,
        accessCode: "",
        allowedEvents: {},
        lastLogin: serverTimestamp()
      },
      { merge: true }
    );

    console.log("[PROFILE SAVED]", {
      uid: user.uid,
      email: user.email || "",
      role,
      nickname
    });

    location.href = "./hub.html";
  } catch (error) {
    console.error("save profile error:", error);
    alert("회원 정보 저장 실패");
  }
}

getRedirectResult(auth)
  .then(async (result) => {
    if (result?.user) {
      await handleLoggedInUser(result.user);
    }
  })
  .catch((error) => {
    console.error("redirect result error:", error);
  });

googleBtn?.addEventListener("click", login);
signupConfirm?.addEventListener("click", saveProfile);
