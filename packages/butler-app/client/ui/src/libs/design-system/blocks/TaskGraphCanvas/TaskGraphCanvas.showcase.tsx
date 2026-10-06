import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { TaskGraphCanvas } from "./TaskGraphCanvas";
import { DemoCard, DemoGraphView, demoNodes, type DemoGraphId } from "./TaskGraphCanvas.showcaseParts";
import { GRAPHS, type DemoGraph } from "./TaskGraphCanvas.showcaseData";

export const meta: ShowcaseMeta = {
  title: "TaskGraphCanvas",
  category: "Inspector",
  tags: ["task", "graph", "dag", "dependencies", "canvas", "workers"],
  status: "beta",
};

const NAMES: Array<[DemoGraphId, string]> = [
  ["one", "One task"],
  ["chain", "Chain"],
  ["fanout", "Fan-out and join"],
  ["failed", "Failed task (blocked join)"],
  ["cancelled", "Cancelled"],
  ["skip", "Rank-skipping edge (dummy slot)"],
  ["long", "Long graph (16 tasks)"],
];

export const stories: ShowcaseStory[] = [
  ...NAMES.map(([id, name]): ShowcaseStory => ({
    name: `${name} · left to right`,
    widths: ["app", "wide"],
    render: ({ locale }) => <DemoGraphView graph={GRAPHS[id] as DemoGraph} locale={locale} orientation="horizontal" detail={false} />,
  })),
  {
    name: "Fan-out and join · phone (auto switches to lanes)",
    widths: ["375"],
    render: ({ locale }) => <DemoGraphView graph={GRAPHS.fanout} locale={locale} orientation="vertical" detail={false} />,
  },
  {
    name: "Plain renderNode (no selection)",
    widths: ["app"],
    render: ({ locale }) => (
      <TaskGraphCanvas nodes={demoNodes(GRAPHS.chain)} edges={GRAPHS.chain.edges} label={GRAPHS.chain.title[locale]} orientation="horizontal"
        renderNode={(id) => <DemoCard task={GRAPHS.chain.tasks.find((task) => task.id === id)!} locale={locale} />} />
    ),
  },
];
