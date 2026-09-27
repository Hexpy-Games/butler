import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { AttachedComposer } from "../../showcase/support/AttachedComposer";
import { ListChecks } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { ComposerAdjunctPanel } from "./ComposerAdjunctPanel";

export const meta: ShowcaseMeta = {
  title: "ComposerAdjunctPanel",
  category: "Composer",
  tags: ["composer", "adjunct", "collapsible", "panel"],
  status: "stable",
};

const labels = {
  "en-US": {
    heading: "Attached panel", body: "Panel content follows the composer inset rhythm. TodoProgressPanel and WorkerActivityPanel build on this shell.",
    summary: "3 of 5 steps done",
  },
  "ko-KR": {
    heading: "첨부 패널", body: "패널 내용은 컴포저의 안쪽 여백 리듬을 따릅니다. TodoProgressPanel과 WorkerActivityPanel이 이 틀 위에 만들어집니다.",
    summary: "5단계 중 3단계 완료",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Attached to the composer",
    widths: ["375", "app"],
    render: (context) => (
      <AttachedComposer context={context} adjunct={(
        <ComposerAdjunctPanel heading={text(context).heading} icon={<ListChecks size="md" />} collapsedSummary={text(context).summary}>
          <Typo.Body>{text(context).body}</Typo.Body>
        </ComposerAdjunctPanel>
      )} />
    ),
  },
  {
    name: "Collapsed by default",
    states: ["collapsed"],
    render: (context) => (
      <ComposerAdjunctPanel defaultCollapsed heading={text(context).heading} icon={<ListChecks size="md" />} collapsedSummary={text(context).summary}>
        <Typo.Body>{text(context).body}</Typo.Body>
      </ComposerAdjunctPanel>
    ),
  },
];
