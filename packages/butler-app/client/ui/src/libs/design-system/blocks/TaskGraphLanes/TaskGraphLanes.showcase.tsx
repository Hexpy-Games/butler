import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { DemoCard, DemoGraphView, demoNodes, type DemoGraphId } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseParts";
import { GRAPHS, type DemoGraph } from "../TaskGraphCanvas/TaskGraphCanvas.showcaseData";
import { TaskGraphLanes } from "./TaskGraphLanes";

export const meta: ShowcaseMeta = {
  title: "TaskGraphLanes",
  category: "Inspector",
  tags: ["task", "graph", "lanes", "phone", "vertical"],
  status: "beta",
};

const NAMES: Array<[DemoGraphId, string]> = [
  ["chain", "Chain"],
  ["fanout", "Fan-out and join"],
  ["failed", "Failed task"],
  ["cancelled", "Cancelled"],
  ["skip", "Rank-skipping edge"],
  ["long", "Long graph (16 tasks)"],
];

export const stories: ShowcaseStory[] = [
  ...NAMES.map(([id, name]): ShowcaseStory => ({
    name,
    widths: ["320", "375", "430"],
    render: ({ locale }) => <DemoGraphView graph={GRAPHS[id] as DemoGraph} locale={locale} orientation="vertical" detail={false} />,
  })),
  {
    name: "Lanes block alone",
    widths: ["375"],
    render: ({ locale }) => (
      <TaskGraphLanes nodes={demoNodes(GRAPHS.fanout)} edges={GRAPHS.fanout.edges} label={GRAPHS.fanout.title[locale]}
        renderNode={(id) => <DemoCard task={GRAPHS.fanout.tasks.find((task) => task.id === id)!} locale={locale} />} />
    ),
  },
];
