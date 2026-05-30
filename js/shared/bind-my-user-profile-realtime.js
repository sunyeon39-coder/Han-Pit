import { db } from "../firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { mergeOpsProfile, normalizeUserProfile } from "./auth-helpers.js";
import { enrichProfileWithEmailAllows } from "./load-user-profile.js";

let stopMyProfileWatch = null;
let lastProfile = null;

export function bindMyUserProfileRealtime(uid, { email = "", onProfileChange } = {}) {
  disposeMyUserProfileRealtime();
  if (!uid || typeof onProfileChange !== "function") return;

  lastProfile = null;

  stopMyProfileWatch = onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (!snap.exists()) return;
      const raw = normalizeUserProfile(snap.data() || {}, email);
      const merged = mergeOpsProfile(lastProfile, raw, snap.metadata || {});
      void enrichProfileWithEmailAllows(uid, email, merged, {
        preferCacheFirst: false,
        forceServer: true
      }).then(
        (profile) => {
          lastProfile = profile;
          onProfileChange(profile, snap.metadata || {});
        }
      );
    },
    (err) => {
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
}

export function seedMyUserProfileCache(profile) {
  lastProfile = profile || null;
}
