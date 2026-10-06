import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { DemoDetail } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseParts";
import { GRAPHS } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseData";
import { TaskGraphDetail } from "./TaskGraphDetail";

export const meta: ShowcaseMeta = {
  title: "TaskGraphDetail",
  category: "Inspector",
  tags: ["task", "graph", "detail", "document", "conversation"],
  status: "beta",
};

const pick = (graph: keyof typeof GRAPHS, id: string) => GRAPHS[graph].tasks.find((task) => task.id === id)!;

export const stories: ShowcaseStory[] = [
  { name: "Running (live step, conversation)", render: ({ locale }) => <DemoDetail graph={GRAPHS.fanout} task={pick("fanout", "r2")} locale={locale} /> },
  { name: "Failed (reason notice)", render: ({ locale }) => <DemoDetail graph={GRAPHS.failed} task={pick("failed", "r2")} locale={locale} /> },
  { name: "Blocked by a failure", render: ({ locale }) => <DemoDetail graph={GRAPHS.failed} task={pick("failed", "compare")} locale={locale} /> },
  { name: "Waiting, not assigned (no conversation)", render: ({ locale }) => <DemoDetail graph={GRAPHS.fanout} task={pick("fanout", "review")} locale={locale} /> },
  {
    name: "Minimal",
    render: ({ locale }) => (
      <TaskGraphDetail title={GRAPHS.one.tasks[0]!.title[locale]} status="done" statusLabel={locale === "ko-KR" ? "완료" : "Done"}
        facts={[{ id: "time", label: locale === "ko-KR" ? "걸린 시간" : "Time", value: "1m 36s" }]} />
    ),
  },
];
