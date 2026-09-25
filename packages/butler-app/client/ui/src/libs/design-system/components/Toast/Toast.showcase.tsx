import { Toaster, toast } from "sonner";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { toastClassNames } from "./Toast";

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
  },
  "ko-KR": {
    hint: "토스트는 창 위쪽 가운데에 나타나고 스스로 사라집니다.",
    success: "성공 보기", saved: "설정을 저장했습니다",
    message: "메시지 보기", queued: "메시지를 대기열에 넣었습니다. 현재 작업이 끝나면 보냅니다.",
    error: "오류 보기", failed: "모델 제공자에 연결하지 못했습니다.",
    loading: "진행 보기", checking: "업데이트를 확인하는 중…", done: "Butler가 최신 버전입니다",
    action: "실행 취소 보기", archived: "대화를 보관했습니다", undo: "실행 취소",
  },
} as const;

function ToastDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <Stack gap="md">
      <Typo.Caption>{text.hint}</Typo.Caption>
      <Stack align="row" gap="sm" wrap>
        <Button size="sm" variant="outline" text={text.success} onClick={() => toast.success(text.saved)} />
        <Button size="sm" variant="outline" text={text.message} onClick={() => toast.message(text.queued)} />
        <Button size="sm" variant="outline" text={text.error} onClick={() => toast.error(text.failed)} />
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
      {/* Same configuration as the app's AppToaster. */}
      <Toaster closeButton gap={8} position="top-center" richColors={false} toastOptions={{ classNames: toastClassNames }} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Tones", states: ["success", "message", "error", "loading", "action"], render: (context) => <ToastDemo {...context} /> },
];
