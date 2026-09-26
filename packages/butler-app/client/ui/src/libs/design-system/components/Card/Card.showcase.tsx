import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Grid } from "../Grid";
import { MessageSquare } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Card } from "./Card";

export const meta: ShowcaseMeta = {
  title: "Card",
  category: "Layout",
  tags: ["surface", "container", "card", "dashboard"],
  status: "stable",
};

const labels = {
  "en-US": {
    board: [
      { title: "Ship the DS Viewer token pages", progress: "Tasks 3/5 · Plan 2/4", session: "Token page review" },
      { title: "Move settings to the section-header pattern", progress: "Tasks 1/3", session: "Settings S7" },
      { title: "Trace send flight at 20 chunks per second", progress: "Plan 4/4", session: "Motion trace" },
    ],
    suggestion: "Draft the weekly release notes",
    reason: "Three merged PRs are not in any changelog yet.",
    start: "Start",
    seedTitle: "Branched from",
    seed: "Earlier turns summarized the plan and the open questions about the gateway API.",
    padding: { none: "padding none", sm: "padding sm", md: "padding md" },
  },
  "ko-KR": {
    board: [
      { title: "DS Viewer 토큰 페이지 배포", progress: "작업 3/5 · 계획 2/4", session: "토큰 페이지 검토" },
      { title: "설정을 섹션 헤더 패턴으로 옮기기", progress: "작업 1/3", session: "설정 S7" },
      { title: "초당 20청크에서 전송 비행 추적", progress: "계획 4/4", session: "모션 추적" },
    ],
    suggestion: "주간 릴리스 노트 초안 작성",
    reason: "병합된 PR 세 개가 아직 변경 기록에 없습니다.",
    start: "시작",
    seedTitle: "분기 원본",
    seed: "이전 대화에서 계획과 게이트웨이 API에 대한 열린 질문을 요약했습니다.",
    padding: { none: "여백 없음", sm: "여백 sm", md: "여백 md" },
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Project board card (ProjectBoardCard): interactive card with a nested session button. */
function BoardCard({ item, selected }: { item: { title: string; progress: string; session: string }; selected?: boolean }) {
  return (
    <Card interactive selected={selected} aria-label={item.title} onClick={() => undefined}>
      <Stack gap="md">
        <Typo.Body lineClamp={2} wrap="anywhere">{item.title}</Typo.Body>
        <Typo.Caption>{item.progress}</Typo.Caption>
        <Button variant="borderless" size="xs" onClick={(event) => event.stopPropagation()}>
          <MessageSquare />
          <Typo.Text truncate>{item.session}</Typo.Text>
        </Button>
      </Stack>
    </Card>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Project board",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <Grid columns="auto-fit" gap="md">
        {text(context).board.map((item, index) => <BoardCard item={item} key={item.title} selected={index === 0} />)}
      </Grid>
    ),
  },
  {
    name: "Briefing suggestion",
    render: (context) => (
      <Card>
        <Stack gap="md">
          <Typo.Body>{text(context).suggestion}</Typo.Body>
          <Typo.Caption tone="secondary">{text(context).reason}</Typo.Caption>
          <Button variant="outline" size="sm" text={text(context).start} />
        </Stack>
      </Card>
    ),
  },
  {
    name: "Branch seed (static)",
    render: (context) => (
      <Card>
        <Stack gap="sm">
          <Typo.SectionTitle>{text(context).seedTitle}</Typo.SectionTitle>
          <Typo.Body>{text(context).seed}</Typo.Body>
        </Stack>
      </Card>
    ),
  },
  {
    name: "Padding",
    render: (context) => (
      <Stack gap="sm">
        {(["none", "sm", "md"] as const).map((padding) => (
          <Card key={padding} padding={padding}><Typo.Caption>{text(context).padding[padding]}</Typo.Caption></Card>
        ))}
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected"],
  render: (context) => {
    const [item] = text(context).board;
    return <BoardCard item={item} selected={context.state === "selected"} />;
  },
};
