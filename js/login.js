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
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  limit
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

async function findLegacyUserDocByEmail(user) {
  if (!user?.email) return null;

  const email = String(user.email || "").trim().toLowerCase();

  const q = query(
    collection(db, "users"),
    where("email", "==", email),
    limit(1)
  );

  const snap = await getDocs(q);
  if (snap.empty) return null;

  const legacyDoc = snap.docs[0];
  return {
    id: legacyDoc.id,
    data: legacyDoc.data() || {}
  };
}

async function ensureUserDoc(user) {
  if (!user) return null;

  const uid = user.uid;
  const userRef = doc(db, "users", uid);
  const currentSnap = await getDoc(userRef);

  const email = String(user.email || "").trim().toLowerCase();
  const role = isAdminEmail(email) ? "admin" : "user";

  // 1) 이미 현재 uid 문서가 있으면 최소 정보 갱신
  if (currentSnap.exists()) {
    await updateDoc(userRef, {
      email: user.email || "",
      photoURL: String(user.photoURL || "").trim(),
      lastLogin: serverTimestamp()
    });

    return {
      created: false,
      migrated: false,
      role
    };
  }

  // 2) 예전 구조(users/{randomDocId}) 복구 시도
  const legacy = await findLegacyUserDocByEmail(user);

  if (legacy) {
    const legacyData = legacy.data || {};
    const legacyRole = String(legacyData.role || "user").trim();

    await setDoc(
      userRef,
      {
        email: user.email || "",
        nickname: String(legacyData.nickname || user.displayName || "").trim(),
        phone: String(legacyData.phone || "").trim(),
        gender: String(legacyData.gender || "none").trim(),
        photoURL: String(legacyData.photoURL || user.photoURL || "").trim(),
        role: isAdminEmail(email) ? "admin" : (legacyRole || "user"),
        accessCode: legacyData.accessCode || "",
        allowedEvents: legacyData.allowedEvents || {},
        createdAt: legacyData.createdAt || serverTimestamp(),
        lastLogin: serverTimestamp()
      },
      { merge: true }
    );

    return {
      created: true,
      migrated: true,
      role: isAdminEmail(email) ? "admin" : (legacyRole || "user")
    };
  }

  // 3) 완전 신규 유저 생성
  await setDoc(
    userRef,
    {
      email: user.email || "",
      nickname: String(user.displayName || "").trim(),
      phone: "",
      gender: "none",
      photoURL: String(user.photoURL || "").trim(),
      role,
      accessCode: "",
      allowedEvents: {},
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp()
    },
    { merge: true }
  );

  return {
    created: true,
    migrated: false,
    role
  };
}

async function ensureUserRole(user) {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) return;

  const email = String(user.email || "").trim().toLowerCase();
  const nextRole = isAdminEmail(email) ? "admin" : "user";

  await updateDoc(userRef, {
    role: nextRole,
    email: user.email || "",
    photoURL: String(user.photoURL || "").trim(),
    lastLogin: serverTimestamp()
  });
}

async function syncUserProfile(user) {
  if (!user) {
    return {
      ok: false,
      reason: "no-user"
    };
  }

  try {
    const ensureResult = await ensureUserDoc(user);
    await ensureUserRole(user);

    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    const data = snap.exists() ? (snap.data() || {}) : null;

    return {
      ok: true,
      ensureResult,
      profile: data
    };
  } catch (error) {
    console.error("[syncUserProfile] error:", error);
    return {
      ok: false,
      error
    };
  }
}

async function finalizeLoginFlow(user) {
  if (!user) return;

  const syncResult = await syncUserProfile(user);

  console.log("[LOGIN FLOW]", {
    uid: user.uid,
    email: user.email || "",
    syncResult,
    isAdminEmail: isAdminEmail(user.email || "")
  });

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
