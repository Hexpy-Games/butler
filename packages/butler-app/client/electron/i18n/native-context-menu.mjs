const copy = {
  "en-US": {
    openInNewTab: "Open in new tab",
    openInButler: "Open in Butler",
    openInBrowser: (name) => `Open in ${name}`,
    copyLink: "Copy link",
    copy: "Copy",
    selectAll: "Select All",
    paste: "Paste",
  },
  "ko-KR": {
    openInNewTab: "새 탭에서 열기",
    openInButler: "버틀러에서 열기",
    openInBrowser: (name) => `다음 브라우저로 열기: ${name}`,
    copyLink: "링크 복사",
    copy: "복사",
    selectAll: "모두 선택",
    paste: "붙여넣기",
  },
};

/** Native Electron labels shared with the typed App i18n catalogs. */
export function nativeContextMenuCopy(language) {
  return copy[language?.toLowerCase().startsWith("ko") ? "ko-KR" : "en-US"];
}
