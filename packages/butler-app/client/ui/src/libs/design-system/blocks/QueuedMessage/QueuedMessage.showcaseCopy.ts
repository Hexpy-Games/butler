import type { ShowcaseRenderContext } from "../../showcase";

const labels = {
  "en-US": {
    queued: "Queued",
    position: (position: number, total: number) => `Queued · ${position} of ${total}`,
    sending: "Sending…",
    failed: "Send failed",
    sendNow: "Send now",
    sendNowHint: "Stop the current response and send this next",
    edit: "Edit queued message",
    remove: "Delete queued message",
    retry: "Retry message",
    removeFailed: "Delete failed message",
    replay: "Replay",
    send: "Send",
    sendBusy: "Send while busy",
    sendFallback: "Send (no flight)",
    sendLong: "Send a long message",
    showMore: "Show more",
    showLess: "Show less",
    token: "Check https://example.com/releases/2026-09-25/artifacts/butler-desktop-universal-build-0123456789abcdef0123456789abcdef/manifest.json?download=true&signature=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 before shipping.",
    placeholder: "Ask Butler",
    messages: [
      "Add screenshots to the final report before sending.",
      "Also mention that MCP secrets stay redacted.",
      "Then open a draft PR.",
    ],
    long: "When you finish the migration, re-run the layout smoke at 375 and 1440, compare the screenshots with the ones from yesterday, and list every row whose height changed by more than two pixels together with the component that owns it. If anything moved in the sidebar, stop there and ask me before touching the tokens.",
    sent: "Summarize the motion system.",
  },
  "ko-KR": {
    queued: "대기 중",
    position: (position: number, total: number) => `대기 중 · ${total}개 중 ${position}번째`,
    sending: "보내는 중…",
    failed: "전송 실패",
    sendNow: "바로 반영",
    sendNowHint: "현재 응답을 멈추고 이 메시지를 바로 보냅니다",
    edit: "대기 메시지 수정",
    remove: "대기 메시지 삭제",
    retry: "다시 작성",
    removeFailed: "실패 메시지 삭제",
    replay: "다시 재생",
    send: "보내기",
    sendBusy: "작업 중에 보내기",
    sendFallback: "보내기 (비행 없음)",
    sendLong: "긴 메시지 보내기",
    showMore: "더 보기",
    showLess: "접기",
    token: "배포 전에 https://example.com/releases/2026-09-25/artifacts/butler-desktop-universal-build-0123456789abcdef0123456789abcdef/manifest.json?download=true&signature=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 를 확인해 줘.",
    placeholder: "Butler에게 물어보기",
    messages: [
      "보내기 전에 최종 보고서에 스크린샷을 추가해 줘.",
      "MCP 비밀 값은 계속 가려진다는 점도 적어 줘.",
      "그다음 초안 PR을 열어 줘.",
    ],
    long: "마이그레이션이 끝나면 375와 1440에서 레이아웃 스모크를 다시 돌리고 어제 스크린샷과 비교해서, 높이가 2픽셀 넘게 바뀐 행을 담당 컴포넌트와 함께 전부 정리해 줘. 사이드바에서 움직인 게 있으면 거기서 멈추고 토큰을 건드리기 전에 먼저 물어봐.",
    sent: "모션 시스템을 요약해 줘.",
  },
} as const;

export type QueuedShowcaseCopy = (typeof labels)[keyof typeof labels];

export function queuedShowcaseCopy({ locale }: ShowcaseRenderContext): QueuedShowcaseCopy {
  return labels[locale];
}
