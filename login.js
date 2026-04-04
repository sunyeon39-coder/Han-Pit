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

let selectedGender = "none";

const ADMIN_EMAILS = [
  "YOUR_ADMIN_EMAIL@gmail.com"
  // "SECOND_ADMIN_EMAIL@gmail.com"
];

function isAdminEmail(email = "") {
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
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

async function ensureUserRole(user) {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  const email = String(user.email || "").trim().toLowerCase();
  const shouldBeAdmin = isAdminEmail(email);

  if (!snap.exists()) return;

  const data = snap.data() || {};
  const currentRole = String(data.role || "user").trim();
  const nextRole = shouldBeAdmin ? "admin" : currentRole || "user";

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
  const snap = await getDoc(userRef);

  console.log("[LOGIN OK]", {
    uid: user.uid,
    email: user.email || "",
    hasProfile: snap.exists(),
    isAdminEmail: isAdminEmail(user.email || "")
  });

  if (!snap.exists()) {
    signupModal.classList.remove("hidden");
    return;
  }

  await ensureUserRole(user);
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
    const nickname = document.getElementById("nicknameInput").value.trim();
    const phone = document.getElementById("phoneInput").value.trim();

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

    await setDoc(doc(db, "users", uid), {
      email: user.email || "",
      nickname,
      phone,
      gender: selectedGender,
      role,
      accessCode: "",
      allowedEvents: {},
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp()
    });

    console.log("[PROFILE CREATED]", {
      uid: user.uid,
      email: user.email || "",
      role
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