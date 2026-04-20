export function getIdentityKey({ uid = "", email = "", name = "" } = {}) {
  const safeUid = String(uid || "").trim();
  if (safeUid) return `uid:${safeUid}`;

  const safeEmail = String(email || "").trim().toLowerCase();
  if (safeEmail) return `email:${safeEmail}`;

  const safeName = String(name || "").trim();
  if (safeName) return `name:${safeName}`;

  return "";
}

export function getWaitingIdentity(waiting, getIdentityKeyFn = getIdentityKey) {
  return getIdentityKeyFn({
    uid: waiting?.uid || "",
    email: waiting?.email || "",
    name: waiting?.name || ""
  });
}

export function getSeatIdentity(seat, getIdentityKeyFn = getIdentityKey) {
  return getIdentityKeyFn({
    uid: seat?.personUid || "",
    email: seat?.personEmail || "",
    name: seat?.person || ""
  });
}
