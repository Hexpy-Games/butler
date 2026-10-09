import { toast } from "sonner";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";

export const meta: ShowcaseMeta = {
  title: "Toast",
  category: "Feedback",
  tags: ["notification", "sonner", "status", "transient"],
  status: "stable",
};

const copy = {
  "en-US": {
    hint: "Toasts appear at the top center of the window and dismiss themselves.",
    success: "Show success", saved: "Settings saved",
    message: "Show message", queued: "Message queued; it sends when the current turn ends.",
    error: "Show error", failed: "Could not reach the model provider.",
    loading: "Show loading", checking: "Checking for updates…", done: "Butler is up to date",
    action: "Show with action", archived: "Conversation archived", undo: "Undo",
    warning: "Show warning", slow: "The model provider is responding slowly.",
    burst: "Show three in a row", motion: "Toasts drop in 24px and fade on --motion-enter-overlay (the standard enter curve) and leave on --motion-exit-base; reduced motion only fades.",
  },
  "ko-KR": {
    hint: "토스트는 창 위쪽 가운데에 나타나고 스스로 사라집니다.",
    success: "성공 보기", saved: "설정을 저장했습니다",
    message: "메시지 보기", queued: "메시지를 대기열에 넣었습니다. 현재 작업이 끝나면 보냅니다.",
    error: "오류 보기", failed: "모델 제공자에 연결하지 못했습니다.",
    loading: "진행 보기", checking: "업데이트를 확인하는 중…", done: "버틀러가 최신 버전입니다",
    action: "실행 취소 보기", archived: "대화를 보관했습니다", undo: "실행 취소",
    warning: "경고 보기", slow: "모델 제공자의 응답이 느립니다.",
    burst: "세 개 연달아 보기", motion: "토스트는 24px 내려오며 나타나고(--motion-enter-overlay) 더 빨리 사라집니다(--motion-exit-base). 동작 줄이기에서는 페이드만 합니다.",
  },
} as const;

function MotionDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <Stack gap="md">
      <Typo.Caption>{text.motion}</Typo.Caption>
      <Button size="sm" variant="outline" data-ds-motion="toast" text={text.burst} onClick={() => {
        toast.success(text.saved);
        window.setTimeout(() => toast.message(text.queued), 180);
        window.setTimeout(() => toast.error(text.failed), 360);
      }} />
    </Stack>
  );
}

// The DS Viewer mounts the one DS Toaster at its root, as the app mounts AppToaster.
function ToastDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <Stack gap="md">
      <Typo.Caption>{text.hint}</Typo.Caption>
      <Stack align="row" gap="sm" wrap>
        <Button size="sm" variant="outline" text={text.success} onClick={() => toast.success(text.saved)} />
        <Button size="sm" variant="outline" text={text.message} onClick={() => toast.message(text.queued)} />
        <Button size="sm" variant="outline" text={text.error} onClick={() => toast.error(text.failed)} />
        <Button size="sm" variant="outline" text={text.warning} onClick={() => toast.warning(text.slow)} />
        <Button
          size="sm"
          variant="outline"
          text={text.loading}
          onClick={() => {
            const id = toast.loading(text.checking);
            window.setTimeout(() => toast.success(text.done, { id }), 1400);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          text={text.action}
          onClick={() => toast.message(text.archived, { action: { label: text.undo, onClick: () => undefined } })}
        />
      </Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Tones", states: ["success", "message", "error", "warning", "loading", "action"], render: (context) => <ToastDemo {...context} /> },
  { name: "Motion", states: ["enter", "stack", "exit"], render: (context) => <MotionDemo {...context} /> },
];
