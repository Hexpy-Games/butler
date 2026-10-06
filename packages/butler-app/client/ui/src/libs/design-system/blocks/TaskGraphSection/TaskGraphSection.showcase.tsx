import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { DemoPanel } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseParts";
import { GRAPHS } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseData";
import { TaskGraphPanel, TaskGraphSection } from "./TaskGraphSection";

export const meta: ShowcaseMeta = {
  title: "TaskGraphSection",
  category: "Inspector",
  tags: ["task", "graph", "section", "disclosure", "tasks tab"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  { name: "Empty", render: ({ locale }) => <DemoPanel graphIds={[]} locale={locale} /> },
  { name: "One graph (no row)", widths: ["375", "app"], render: ({ locale }) => <DemoPanel graphIds={["fanout"]} locale={locale} /> },
  { name: "Two graphs (running open, finished folded)", widths: ["375", "app"], render: ({ locale }) => <DemoPanel graphIds={["fanout", "chainDone"]} locale={locale} /> },
  {
    name: "Six graphs (running and failed open)",
    widths: ["375", "app"],
    render: ({ locale }) => <DemoPanel graphIds={["chainDone", "long", "failed", "fanout", "cancelled", "one"]} locale={locale} />,
  },
  {
    name: "Folded rows only",
    render: ({ locale }) => (
      <TaskGraphPanel title={locale === "ko-KR" ? "작업 그래프" : "Task graph"} emptyLabel="" headerMeta={locale === "ko-KR" ? "그래프 2개" : "2 graphs"}>
        {[GRAPHS.chainDone, GRAPHS.cancelled].map((graph) => (
          <TaskGraphSection key={graph.id} graphId={graph.id} title={graph.title[locale]} status={graph.id === "cancelled" ? "cancelled" : "done"}
            meta={`${graph.tasks.filter((task) => task.status === "done").length}/${graph.tasks.length}`} open={false} onToggle={() => undefined}>
            {null}
          </TaskGraphSection>
        ))}
      </TaskGraphPanel>
    ),
  },
];
