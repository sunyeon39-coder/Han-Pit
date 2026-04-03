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
  console.log("[findLegacyUserDocByEmail] start", email);

  const q = query(
    collection(db, "users"),
    where("email", "==", email),
    limit(1)
  );

  const snap = await getDocs(q);
  console.log("[findLegacyUserDocByEmail] empty?", snap.empty, "size:", snap.size);

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

  console.log("[ensureUserDoc] start", {
    uid,
    email: user.email || ""
  });

  const snap = await getDoc(userRef);
  console.log("[ensureUserDoc] current uid doc exists?", snap.exists());

  const email = String(user.email || "").trim().toLowerCase();
  const role = isAdminEmail(email) ? "admin" : "user";

  if (snap.exists()) {
    console.log("[ensureUserDoc] update existing uid doc");

    await updateDoc(userRef, {
      email: user.email || "",
      photoURL: String(user.photoURL || "").trim(),
      lastLogin: serverTimestamp()
    });

    console.log("[ensureUserDoc] update existing uid doc success");

    return {
      created: false,
      migrated: false,
      role
    };
  }

  console.log("[ensureUserDoc] searching legacy doc by email");
  const legacy = await findLegacyUserDocByEmail(user);
  console.log("[ensureUserDoc] legacy result", legacy);

  if (legacy) {
    const legacyData = legacy.data || {};
    const legacyRole = String(legacyData.role || "user").trim();

    console.log("[ensureUserDoc] migrating legacy doc to uid doc");

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

    console.log("[ensureUserDoc] migrate success");

    return {
      created: true,
      migrated: true,
      role: isAdminEmail(email) ? "admin" : (legacyRole || "user")
    };
  }

  console.log("[ensureUserDoc] creating brand new uid doc");

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

  console.log("[ensureUserDoc] create success");

  return {
    created: true,
    migrated: false,
    role
  };
}

async function ensureUserRole(user) {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);
  console.log("[ensureUserRole] start", { uid: user.uid, email: user.email || "" });

  const snap = await getDoc(userRef);
  console.log("[ensureUserRole] uid doc exists?", snap.exists());

  const email = String(user.email || "").trim().toLowerCase();
  const shouldBeAdmin = isAdminEmail(email);

  if (!snap.exists()) {
    console.log("[ensureUserRole] skipped because uid doc does not exist");
    return;
  }

  const data = snap.data() || {};
  const currentRole = String(data.role || "user").trim();
  const nextRole = shouldBeAdmin ? "admin" : "user";

  console.log("[ensureUserRole] role check", {
    currentRole,
    nextRole
  });

  await updateDoc(userRef, {
    role: nextRole,
    email: user.email || "",
    photoURL: String(user.photoURL || "").trim(),
    lastLogin: serverTimestamp()
  });

  console.log("[ensureUserRole] update success");

  return currentRole !== nextRole;
}

async function syncUserProfile(user) {
  if (!user) {
    return {
      ok: false,
      reason: "no-user"
    };
  }

  try {
    console.log("[syncUserProfile] start");

    const ensureResult = await ensureUserDoc(user);
    console.log("[syncUserProfile] ensureUserDoc success", ensureResult);

    await ensureUserRole(user);
    console.log("[syncUserProfile] ensureUserRole success");

    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    console.log("[syncUserProfile] final getDoc success", snap.exists());

    const data = snap.exists() ? (snap.data() || {}) : null;

    return {
      ok: true,
      ensureResult,
      profile: data
    };
  } catch (error) {
    console.error("[syncUserProfile] error", error);
    return {
      ok: false,
      error
    };
  }
}

async function finalizeLoginFlow(user) {
  if (!user) return;

  console.log("[finalizeLoginFlow] start", {
    uid: user.uid,
    email: user.email || ""
  });

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
      "대부분 Firestore Rules 문제입니다.\n\n" +
      `에러: ${syncResult.error?.message || syncResult.error || "unknown"}`
    );
    return;
  }

  const profile = syncResult.profile || {};
  const nickname = String(profile.nickname || "").trim();

  console.log("[finalizeLoginFlow] nickname check", {
    nickname,
    length: nickname.length
  });

  if (!nickname || nickname.length < 2) {
    console.log("[finalizeLoginFlow] open signup modal");
    openSignupModal(profile);
    return;
  }

  console.log("[finalizeLoginFlow] redirect to hub");
  location.href = "./hub.html";
}

async function login() {
  try {
    console.log("[LOGIN] popup start");
    const result = await signInWithPopup(auth, provider);
    console.log("[LOGIN] popup success", result?.user?.uid, result?.user?.email);
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
        console.log("[LOGIN] redirect fallback start");
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

    console.log("[saveProfile] start", {
      nickname,
      phone,
      selectedGender
    });

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

    console.log("[saveProfile] success", {
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
    console.log("[LOGIN] redirect result", result);
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
