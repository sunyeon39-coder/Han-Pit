import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db } from "../firebase.js";
import { closeModal } from "../shared/dom-utils.js";
import { hubState } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { renderAdminUserList } from "./hub-admin-ui.js";
import { renderTournaments } from "./hub-tournament-list.js";

export async function saveNickname() {
  const { profileNickname, profileModal } = hubRefs;
  if (!hubState.currentUser) return;

  const nickname = profileNickname.value.trim();

  if (nickname.length < 2 || nickname.length > 7) {
    alert("닉네임은 2~7자로 입력해주세요.");
    return;
  }

  try {
    await setDoc(
      doc(db, "users", hubState.currentUser.uid),
      { nickname },
      { merge: true }
    );

    if (hubState.currentUserProfile) {
      hubState.currentUserProfile.nickname = nickname;
    }

    const cacheUser = hubState.usersCache.find((u) => u.uid === hubState.currentUser.uid);
    if (cacheUser) {
      cacheUser.nickname = nickname;
    }

    alert("닉네임이 저장되었습니다.");
    closeModal(profileModal);
    renderAdminUserList();
    renderTournaments(hubState.tournamentsCache, hubState.currentUserProfile, hubState.currentUser);
  } catch (err) {
    console.error(err);
    alert("닉네임 저장에 실패했습니다.");
  }
}
