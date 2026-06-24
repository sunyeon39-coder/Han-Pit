import { auth, db } from "../firebase.js";
import {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  resolveStoredUserRole,
  normalizeUserProfile,
  buildDirectOpsPersistPatch,
  sanitizeAllowedEvents
} from "../shared/auth-helpers.js";

async function waitForFirestoreAuth(user) {
  if (user?.getIdToken) {
    try {
      await user.getIdToken();
      return;
    } catch (err) {
      console.warn("[waitForFirestoreAuth] getIdToken:", err);
    }
  }
  if (typeof auth.authStateReady === "function") {
    await auth.authStateReady();
  }
}

async function readUserDocSnapFromServer(uid) {
  const userRef = doc(db, "users", uid);
  try {
    return await getDocFromServer(userRef);
  } catch {
    return await getDoc(userRef);
  }
}

function buildLoginTouchPatch(user, prev = {}, email = "") {
  const nextRole = resolveStoredUserRole(email, prev);
  const prevRole = String(prev.role || "").trim();
  const patch = {
    email: user.email || "",
    photoURL: String(user.photoURL || "").trim(),
    lastLogin: serverTimestamp()
  };
  if (nextRole === prevRole) {
    patch.role = nextRole;
  }
  const nickname = String(prev.nickname || user.displayName || "").trim();
  if (nickname && !String(prev.nickname || "").trim()) {
    patch.nickname = nickname;
  }
  return { patch, nextRole };
}

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

  await waitForFirestoreAuth(user);

  const uid = user.uid;
  const userRef = doc(db, "users", uid);
  const currentSnap = await readUserDocSnapFromServer(uid);

  const email = String(user.email || "").trim().toLowerCase();

  if (currentSnap.exists()) {
    const prev = currentSnap.data() || {};
    const { patch, nextRole } = buildLoginTouchPatch(user, prev, email);
    try {
      await updateDoc(userRef, patch);
    } catch (err) {
      if (err?.code !== "permission-denied") throw err;
      console.warn("[ensureUserDoc] updateDoc permission denied, using read profile:", err);
    }

    return {
      created: false,
      migrated: false,
      role: nextRole,
      profile: normalizeUserProfile(
        {
          ...prev,
          ...patch,
          email: user.email || "",
          photoURL: String(user.photoURL || "").trim(),
          role: nextRole
        },
        email
      )
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
      allowedEvents: legacyData.allowedEvents || {},
      opsTournamentIds: Array.isArray(legacyData.opsTournamentIds)
        ? legacyData.opsTournamentIds
        : []
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

/** 직접 허용 — role/allowedEvents 가 서버에서 깨졌을 때 복구 시도 (운영진 규칙으로 본인은 실패할 수 있음) */
export async function normalizeAndPersistUserRole(uid, profile, email = "") {
  if (!uid || !profile) return profile;
  const normalized = normalizeUserProfile(profile, email || profile.email || "");
  const patch = buildDirectOpsPersistPatch(profile, email || profile.email || "");
  if (!patch) return normalized;

  const prevRole = String(profile.role || "")
    .trim()
    .toLowerCase();
  const prevAllowed = sanitizeAllowedEvents(profile.allowedEvents || {});
  const needsPersist =
    prevRole !== "admin" ||
    Object.keys(prevAllowed).length < Object.keys(patch.allowedEvents || {}).length;

  if (needsPersist) {
    try {
      await updateDoc(doc(db, "users", uid), patch);
    } catch (err) {
      console.warn("[normalizeAndPersistUserRole] update failed:", err?.code || err);
    }
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

/**
 * 로그인 직후 빠른 경로: users/{uid} 문서가 있으면 캐시 getDoc만으로 프로필 반환.
 * lastLogin 갱신·레거시 이메일 마이그레이션은 백그라운드(syncUserProfile)에 맡긴다.
 */
export async function syncUserProfileFast(user) {
  if (!user?.uid) {
    return { ok: false, reason: "no-user" };
  }

  await waitForFirestoreAuth(user);

  const uid = user.uid;
  const userRef = doc(db, "users", uid);
  const email = String(user.email || "").trim().toLowerCase();

  try {
    let snap = await getDoc(userRef);
    if (!snap.exists()) {
      try {
        snap = await getDocFromServer(userRef);
      } catch (serverErr) {
        console.warn("[syncUserProfileFast] server read:", serverErr?.code || serverErr);
      }
    }
    if (!snap.exists()) {
      return { ok: false, reason: "no-doc", needsFullSync: true };
    }

    const prev = snap.data() || {};
    const { patch, nextRole } = buildLoginTouchPatch(user, prev, email);
    const profile = normalizeUserProfile(
      {
        ...prev,
        email: user.email || prev.email || "",
        photoURL: String(user.photoURL || prev.photoURL || "").trim(),
        role: nextRole
      },
      email
    );

    void updateDoc(userRef, patch).catch((err) => {
      console.warn("[syncUserProfileFast] lastLogin update:", err);
    });

    return {
      ok: true,
      fast: true,
      profile
    };
  } catch (error) {
    console.error("[syncUserProfileFast] error:", error);
    return { ok: false, error, needsFullSync: true };
  }
}

/** 허브 진입 후 lastLogin·레거시 병합 등 — UI는 막지 않음 */
export function scheduleBackgroundUserProfileSync(user) {
  if (!user?.uid) return;
  void syncUserProfile(user).catch((err) => {
    console.warn("[scheduleBackgroundUserProfileSync]", err);
  });
}
