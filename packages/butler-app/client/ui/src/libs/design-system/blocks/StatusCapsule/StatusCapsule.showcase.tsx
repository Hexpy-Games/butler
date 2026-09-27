import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { StatusCapsule } from "./StatusCapsule";

export const meta: ShowcaseMeta = {
  title: "StatusCapsule",
  category: "Composer",
  tags: ["capsule", "progress", "worker", "composer", "pill"],
  status: "beta",
};

const labels = {
  "en-US": { title: "Review the activity surface and every settings page", detail: "Validating the activity surface", short: "Preparing the report" },
  "ko-KR": { title: "활동 화면과 모든 설정 페이지 검토", detail: "활동 화면 확인 중", short: "보고서 준비 중" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Running work above the composer",
    widths: ["375", "app"],
    render: (context) => (
      <Stack align="row" gap="xs" justify="center" wrap>
        <StatusCapsule icon={<Spinner />} title={text(context).title} detail={text(context).detail} progress="2/3"
          aria-label={`${text(context).title} · ${text(context).detail} · 2/3`} onClick={() => undefined} />
        <StatusCapsule icon={<Spinner />} title={text(context).short} aria-label={text(context).short} onClick={() => undefined} />
      </Stack>
    ),
  },
];
