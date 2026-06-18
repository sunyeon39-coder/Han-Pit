/** 닉네임 표시 글자 수 (한글·이모지 등 grapheme 기준, 2~7자) */
export function getNicknameCharCount(value = "") {
  const text = String(value || "").trim();
  if (!text) return 0;

  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return Array.from(new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)).length;
    }
  } catch (_) {
    /* ignore */
  }

  return Array.from(text).length;
}

export function isValidNicknameLength(value = "") {
  const count = getNicknameCharCount(value);
  return count >= 2 && count <= 7;
}

export function readCommittedNicknameInput(input = null) {
  if (!input) return "";
  try {
    input.blur();
  } catch (_) {
    /* ignore */
  }
  return String(input.value || "").trim();
}
