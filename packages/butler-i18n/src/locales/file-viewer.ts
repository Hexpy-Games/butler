export const FILE_VIEWER_COPY = {
  "ko-KR": {
    title: "파일 보기", files: "파일", openInLibrary: "서랍에서 열기", save: "저장하기", close: "닫기", closeFile: "파일 닫기", backToChat: "대화로 돌아가기",
    fileCount: (count: number) => `파일 ${count}개`,
  },
  "en-US": {
    title: "View files", files: "Files", openInLibrary: "Open in Library", save: "Save", close: "Close", closeFile: "Close file", backToChat: "Back to chat",
    fileCount: (count: number) => `${count} ${count === 1 ? "file" : "files"}`,
  },
};
