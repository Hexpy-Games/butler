import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { AlertCircle, CheckCircle2, CircleAlert, CircleX } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Notice } from "./Notice";

export const meta: ShowcaseMeta = {
  title: "Notice",
  category: "Feedback",
  tags: ["status", "inline", "error", "banner"],
  status: "stable",
};

const labels = {
  "en-US": {
    saved: "Settings saved", slow: "The model provider is responding slowly.", created: "Project created",
    failed: "Could not load the dashboard", retryHint: "Check the connection and try again.", retry: "Retry",
    missing: "This project no longer exists", missingHelp: "It may have been removed on another device. Start a new chat instead.",
    newChat: "New chat", loading: "Loading the dashboard…", history: "Project history is unavailable right now.",
  },
  "ko-KR": {
    saved: "설정을 저장했습니다", slow: "모델 제공자의 응답이 느립니다.", created: "프로젝트를 만들었습니다",
    failed: "대시보드를 불러오지 못했습니다", retryHint: "연결을 확인하고 다시 시도하세요.", retry: "다시 시도",
    missing: "이 프로젝트가 더 이상 없습니다", missingHelp: "다른 기기에서 삭제되었을 수 있습니다. 새 채팅을 시작하세요.",
    newChat: "새 채팅", loading: "대시보드를 불러오는 중…", history: "지금은 프로젝트 기록을 볼 수 없습니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Tones",
    render: (context) => (
      <Stack gap="sm">
        <Notice tone="info" icon={<AlertCircle size="md" />} message={text(context).loading} />
        <Notice tone="warning" icon={<CircleAlert size="md" />} message={text(context).slow} />
        <Notice tone="success" icon={<CheckCircle2 size="md" />} message={text(context).created} />
        <Notice tone="error" icon={<CircleX size="md" />} message={text(context).history} />
      </Stack>
    ),
  },
  {
    // ProjectDashboardView: title + message + retry action.
    name: "Error with retry",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Notice tone="error" title={text(context).failed} message={text(context).retryHint}
        action={<Button variant="outline" text={text(context).retry} />} />
    ),
  },
  {
    name: "Missing resource",
    render: (context) => (
      <Notice tone="info" title={text(context).missing} message={text(context).missingHelp}
        action={<Button variant="outline" text={text(context).newChat} />} />
    ),
  },
  {
    name: "Single-line with icon and action",
    widths: ["375", "app"],
    render: (context) => <Notice tone="info" icon={<AlertCircle size="md" />} message={text(context).saved}
      action={<Button variant="outline" text={text(context).retry} />} />,
  },
  {
    name: "Multi-line warning (first-line icon)",
    widths: ["320", "375", "app"],
    render: (context) => <Notice tone="warning" icon={<CircleAlert size="md" />} message={text(context).missingHelp} />,
  },
  {
    // SettingsDetailHeader: a compact result line after saving.
    name: "Inline save result",
    render: (context) => <Notice tone="success" message={text(context).saved} />,
  },
];
