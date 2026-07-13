import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "../firebase.js";
import { closeModal } from "../shared/dom-utils.js";
import {
  isValidNicknameLength,
  readCommittedNicknameInput
} from "../shared/nickname-validation.js";
import { syncUserDisplayNameAfterNicknameChange } from "../shared/sync-user-waiting-display.js";
import { hubState } from "./hub-state.js";
import { hubRefs } from "./hub-dom-refs.js";
import { renderAdminUserList } from "./hub-admin-ui.js";
import { scheduleHubTournamentsRender } from "./hub-realtime-ui.js";

export async function saveNickname() {
  const { profileNickname, profileModal } = hubRefs;
  const user = hubState.currentUser ?? auth.currentUser;
  if (!user) {
    alert("로그인을 확인하는 중입니다. 잠시 후 다시 시도해 주세요.");
    return;
  }

  const nickname = readCommittedNicknameInput(profileNickname);

  if (!isValidNicknameLength(nickname)) {
    alert("닉네임은 2~7자로 입력해주세요.");
    return;
  }

  try {
    await updateDoc(doc(db, "users", user.uid), { nickname });

    try {
      await syncUserDisplayNameAfterNicknameChange(user.uid, nickname);
    } catch (syncErr) {
      console.warn("[saveNickname] display name sync:", syncErr);
    }

    if (hubState.currentUserProfile) {
      hubState.currentUserProfile.nickname = nickname;
    }

    const cacheUser = hubState.usersCache.find((u) => u.uid === user.uid);
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
