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

/**
 * 좌석에 배치된 사람이 현재 로그인 사용자인지 (uid 우선, 없으면 이메일·표시명 보조).
 * 레거시 데이터에 personUid 가 비어 있어도 본인 강조 UI에 쓸 수 있게 한다.
 */
export function isSeatAssignedToCurrentUser(seat, user, profile) {
  if (!seat || !user) return false;
  const person = String(seat.person || "").trim();
  if (!person || person === "비어있음") return false;

  const myUid = String(user.uid || "").trim();
  const seatUid = String(seat.personUid || "").trim();
  if (myUid && seatUid && seatUid === myUid) return true;

  const myEmail = String(user.email || "").trim().toLowerCase();
  const seatEmail = String(seat.personEmail || "").trim().toLowerCase();
  if (myEmail && seatEmail && seatEmail === myEmail) return true;

  if (seatUid || seatEmail) return false;

  const nick = String(profile?.nickname || "").trim();
  if (nick && person === nick) return true;

  const disp = String(user.displayName || "").trim();
  if (disp && person === disp) return true;

  if (myEmail && person.toLowerCase() === myEmail) return true;

  return false;
}
