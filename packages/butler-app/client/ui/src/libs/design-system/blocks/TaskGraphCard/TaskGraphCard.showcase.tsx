import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import type { TaskGraphStatus } from "../../lib/taskGraphLayout";
import { Grid } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DemoCard } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseParts";
import { GRAPHS, STATUS } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseData";
import { TaskGraphCard, TaskGraphStatusIcon, TaskGraphStepLine } from "./TaskGraphCard";

export const meta: ShowcaseMeta = {
  title: "TaskGraphCard",
  category: "Inspector",
  tags: ["task", "graph", "card", "status", "worker"],
  status: "beta",
};

const ALL: TaskGraphStatus[] = ["pending", "running", "review", "done", "failed", "blocked", "cancelled", "paused"];
const running = GRAPHS.fanout.tasks.find((task) => task.id === "r2")!;

export const stories: ShowcaseStory[] = [
  {
    name: "Every status",
    widths: ["375", "app"],
    render: ({ locale }) => (
      <Grid columns="auto-fit" gap="md">
        {ALL.map((status) => (
          <TaskGraphCard key={status} taskId={status} title={running.title[locale]} status={status} statusLabel={STATUS[locale][status]}
            meta={status === "pending" ? undefined : `${running.model}`} time={status === "pending" ? undefined : running.time}
            step={running.step?.[locale]} />
        ))}
      </Grid>
    ),
  },
  {
    name: "Running with a live step, selected",
    render: ({ locale }) => (
      <Stack gap="md">
        <DemoCard task={running} locale={locale} />
        <DemoCard task={running} locale={locale} selected />
      </Stack>
    ),
  },
  {
    name: "Long title (two lines) and unassigned",
    render: ({ locale }) => (
      <TaskGraphCard taskId="long" status="pending" statusLabel={STATUS[locale].pending}
        title={locale === "ko-KR" ? "결과 화면의 정렬 기준을 사용자 설정에 맞추고 이전 기록과 비교하기" : "Match the result ordering to the user's settings and compare it with the previous history"} />
    ),
  },
  {
    name: "Status glyphs and step line",
    render: ({ locale }) => (
      <Stack gap="sm">
        <Stack align="row" gap="md">{ALL.map((status) => <TaskGraphStatusIcon key={status} status={status} />)}</Stack>
        <TaskGraphStepLine step={running.step![locale]} />
        <Typo.Caption tone="tertiary">{STATUS[locale].running}</Typo.Caption>
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected"],
  variants: ["running", "done", "failed"],
  render: ({ locale, state, variant }) => {
    const task = variant === "running" ? running : GRAPHS.failed.tasks.find((item) => item.status === variant)!;
    return <DemoCard task={task} locale={locale} selected={state === "selected"} />;
  },
};
