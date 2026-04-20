import { db } from "../firebase.js";
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
import { isAdminEmail } from "../app_config.js";

export async function findLegacyUserDocByEmail(user) {
  if (!user?.email) return null;

  const email = String(user.email || "").trim().toLowerCase();

  const q = query(collection(db, "users"), where("email", "==", email), limit(1));

  const snap = await getDocs(q);
  if (snap.empty) return null;

  const legacyDoc = snap.docs[0];
  return {
    id: legacyDoc.id,
    data: legacyDoc.data() || {}
  };
}

export async function ensureUserDoc(user) {
  if (!user) return null;

  const uid = user.uid;
  const userRef = doc(db, "users", uid);
  const currentSnap = await getDoc(userRef);

  const email = String(user.email || "").trim().toLowerCase();
  const role = isAdminEmail(email) ? "admin" : "user";

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
        role: isAdminEmail(email) ? "admin" : legacyRole || "user",
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
      role: isAdminEmail(email) ? "admin" : legacyRole || "user"
    };
  }

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

export async function ensureUserRole(user) {
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

export async function syncUserProfile(user) {
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
    const data = snap.exists() ? snap.data() || {} : null;

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
