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
import { resolveStoredUserRole } from "../shared/auth-helpers.js";
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

  if (currentSnap.exists()) {
    const prev = currentSnap.data() || {};
    const nextRole = resolveStoredUserRole(email, prev);
    await updateDoc(userRef, {
      email: user.email || "",
      photoURL: String(user.photoURL || "").trim(),
      lastLogin: serverTimestamp(),
      role: nextRole
    });

    return {
      created: false,
      migrated: false,
      role: nextRole,
      profile: {
        ...prev,
        email: user.email || "",
        photoURL: String(user.photoURL || "").trim(),
        role: nextRole
      }
    };
  }

  const legacy = await findLegacyUserDocByEmail(user);

  if (legacy) {
    const legacyData = legacy.data || {};
    const nextRole = resolveStoredUserRole(email, legacyData);

    const profile = {
      email: user.email || "",
      nickname: String(legacyData.nickname || user.displayName || "").trim(),
      phone: String(legacyData.phone || "").trim(),
      gender: String(legacyData.gender || "none").trim(),
      photoURL: String(legacyData.photoURL || user.photoURL || "").trim(),
      role: nextRole,
      accessCode: legacyData.accessCode || "",
      allowedEvents: legacyData.allowedEvents || {}
    };

    await setDoc(
      userRef,
      {
        ...profile,
        createdAt: legacyData.createdAt || serverTimestamp(),
        lastLogin: serverTimestamp()
      },
      { merge: true }
    );

    return {
      created: true,
      migrated: true,
      role: nextRole,
      profile
    };
  }

  const profile = {
    email: user.email || "",
    nickname: String(user.displayName || "").trim(),
    phone: "",
    gender: "none",
    photoURL: String(user.photoURL || "").trim(),
    role: resolveStoredUserRole(email, {}),
    accessCode: "",
    allowedEvents: {}
  };

  await setDoc(
    userRef,
    {
      ...profile,
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp()
    },
    { merge: true }
  );

  return {
    created: true,
    migrated: false,
    role: profile.role,
    profile
  };
}

/** 직접 허용 등으로 role이 user로 깨진 문서를 로드 시 보정 */
export async function normalizeAndPersistUserRole(uid, profile, email = "") {
  if (!uid || !profile) return profile;
  const normalized = {
    ...profile,
    role: resolveStoredUserRole(email || profile.email, profile)
  };
  const prevRole = String(profile.role || "").trim();
  if (normalized.role !== prevRole) {
    void updateDoc(doc(db, "users", uid), { role: normalized.role }).catch((err) => {
      console.warn("[normalizeAndPersistUserRole] update failed:", err);
    });
  }
  return normalized;
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
    if (!ensureResult) {
      return { ok: false, reason: "ensure-user-failed" };
    }

    return {
      ok: true,
      ensureResult: {
        created: ensureResult.created,
        migrated: ensureResult.migrated,
        role: ensureResult.role
      },
      profile: ensureResult.profile || null
    };
  } catch (error) {
    console.error("[syncUserProfile] error:", error);
    return {
      ok: false,
      error
    };
  }
}
