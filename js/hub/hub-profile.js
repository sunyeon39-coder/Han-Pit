import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "../firebase.js";
import { closeModal } from "../shared/dom-utils.js";
import { syncUserDisplayNameAfterNicknameChange } from "../shared/sync-user-waiting-display.js";
import { hubState } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { renderAdminUserList } from "./hub-admin-ui.js";
import { scheduleHubTournamentsRender } from "./hub-realtime-ui.js";

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

    await syncUserDisplayNameAfterNicknameChange(hubState.currentUser.uid, nickname);

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
    scheduleHubTournamentsRender();
  } catch (err) {
    console.error(err);
    alert("닉네임 저장에 실패했습니다.");
  }
}
