import { db } from "../firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { mergeOpsProfile, normalizeUserProfile } from "./auth-helpers.js";
import { enrichProfileWithEmailAllows } from "./load-user-profile.js";

let stopMyProfileWatch = null;
let lastProfile = null;
let enrichInflight = null;

export function bindMyUserProfileRealtime(uid, { email = "", onProfileChange } = {}) {
  disposeMyUserProfileRealtime();
  if (!uid || typeof onProfileChange !== "function") return;

  lastProfile = null;

  stopMyProfileWatch = onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (!snap.exists()) return;
      const rawData = snap.data() || {};
      const raw = normalizeUserProfile(rawData, email);
      const merged = mergeOpsProfile(lastProfile, raw, snap.metadata || {}, rawData);
      lastProfile = merged;
      onProfileChange(merged, snap.metadata || {});

      if (snap.metadata?.fromCache || enrichInflight) return;

      enrichInflight = enrichProfileWithEmailAllows(uid, email, merged, {
        preferCacheFirst: true
      })
        .then((profile) => {
          if (!profile) return;
          lastProfile = profile;
          onProfileChange(profile, snap.metadata || {});
        })
        .catch((err) => {
          console.warn("bindMyUserProfileRealtime enrich:", err?.code || err);
        })
        .finally(() => {
          enrichInflight = null;
        });
    },
    (err) => {
      const code = String(err?.code || "").trim();
      if (code === "already-exists") {
        console.warn("bindMyUserProfileRealtime: listener target conflict");
        return;
      }
      console.error("bindMyUserProfileRealtime error:", err);
    }
  );
}

export function disposeMyUserProfileRealtime() {
  if (stopMyProfileWatch) {
    stopMyProfileWatch();
    stopMyProfileWatch = null;
  }
  lastProfile = null;
  enrichInflight = null;
}

export function seedMyUserProfileCache(profile) {
  lastProfile = profile || null;
}
