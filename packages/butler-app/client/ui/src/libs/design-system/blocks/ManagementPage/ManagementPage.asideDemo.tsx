import type { ShowcaseRenderContext } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { fixturePicture } from "../../components/MediaFrame/fixtures";
import { Grid } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { AttachmentList } from "../AttachmentList";
import { ScaledFrame } from "../BrowserPane/fixtures/ScaledFrame";
import { ComposerCard } from "../ComposerCard";
import { DashboardHeader } from "../DashboardHeader";
import { MarkdownContent } from "../MarkdownContent";
import { ManagementPage } from "./ManagementPage";
import styles from "./ManagementPage.showcase.module.css";

const copy = {
  "en-US": {
    project: "Butler", description: "Desktop client and gateway.", action: "New task", label: "Task details", prompt: "Ask about this project",
    columns: [["Planned", ["Shortcut input conflict", "Release notes"]], ["In progress", ["Session details area"]], ["Done", ["Card radius"]]],
    title: "Session details area", tags: ["Preview 14", "UI"], state: "In progress · Running",
    intro: "Show the session's open requests, task and results beside the conversation.", heading: "Done when",
    steps: ["Docked in the chat card's margin from 960px", "Floats on glass when narrower"], files: "Attachments",
    shots: [["margin.png", "1.2 MB"], ["floating.png", "Uploading 40%"]],
  },
  "ko-KR": {
    project: "버틀러", description: "데스크톱 클라이언트와 게이트웨이.", action: "새 과제", label: "과제 정보", prompt: "이 프로젝트에 대해 말해 보세요",
    columns: [["계획", ["단축키 입력창 충돌", "릴리스 노트"]], ["진행 중", ["세션 정보 영역"]], ["완료", ["카드 모서리"]]],
    title: "세션 정보 영역", tags: ["프리뷰 14", "UI"], state: "진행 중 · 실행",
    intro: "대화 옆에 세션의 열린 요청, 과제, 결과물을 보여 줍니다.", heading: "완료 기준",
    steps: ["대화 카드가 960px 이상이면 여백에 붙음", "좁으면 유리 패널로 떠 있음"], files: "첨부",
    shots: [["여백.png", "1.2 MB"], ["플로팅.png", "올리는 중 40%"]],
  },
} as const;

/** The selected task: title, tags, its compact Markdown description and attachments. */
function TaskDetail({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Typo.PanelTitle as="h3" wrap="anywhere">{text.title}</Typo.PanelTitle>
        <Typo.Caption tone="secondary">{text.state}</Typo.Caption>
      </Stack>
      <Stack align="row" gap="xs" wrap>{text.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Stack>
      <MarkdownContent density="compact">
        <p>{text.intro}</p>
        <h3>{text.heading}</h3>
        <ul>{text.steps.map((step) => <li key={step}>{step}</li>)}</ul>
      </MarkdownContent>
      <Stack gap="xs">
        <Typo.Caption tone="secondary">{text.files}</Typo.Caption>
        <AttachmentList variant="tiles" tileLayout="wrap" tileAlign="start" onOpen={() => undefined} items={text.shots.map(([name, meta], index) => ({
          id: name, name, meta, thumbnail: { src: fixturePicture(index ? "recipe" : "place") }, upload: index ? "uploading" as const : undefined,
        }))} />
      </Stack>
    </Stack>
  );
}

/** A project board with the selected task in the page's aside, and the overlay composer. */
export function BoardWithTask({ locale, floatOpen = true }: ShowcaseRenderContext & { floatOpen?: boolean }) {
  const text = copy[locale];
  return (
    <ManagementPage dataTestClass="management-page-aside-showcase" asideFloatOpen={floatOpen} asideLabel={text.label}
      aside={<Box paddingX="sm"><TaskDetail locale={locale} /></Box>} footerPlacement="overlay" footerReserve={48}
      footer={<ComposerCard floating><Typo.Body as="p" tone="secondary">{text.prompt}</Typo.Body></ComposerCard>}>
      <DashboardHeader title={text.project} description={text.description} action={<Button variant="outline">{text.action}</Button>} />
      <Grid columns="auto-fit" gap="md" cross="start">
        {text.columns.map(([column, cards]) => (
          <Stack key={column} gap="sm">
            <Typo.Caption tone="secondary">{column}</Typo.Caption>
            {cards.map((card) => <Card key={card} padding="sm" interactive selected={card === text.title} onClick={() => undefined}><Typo.Body>{card}</Typo.Body></Card>)}
          </Stack>
        ))}
      </Grid>
    </ManagementPage>
  );
}

/** Wide: a 1280px page laid out at full size and scaled to the story width, so the aside docks. */
export function WideBoard(context: ShowcaseRenderContext) {
  return <ScaledFrame width={1280} height={640}><BoardWithTask {...context} /></ScaledFrame>;
}

/** Narrow: under 1000px the task floats on glass over the board. */
export function NarrowBoard(context: ShowcaseRenderContext) {
  return <div className={styles.stage} data-width="narrow"><BoardWithTask {...context} /></div>;
}
