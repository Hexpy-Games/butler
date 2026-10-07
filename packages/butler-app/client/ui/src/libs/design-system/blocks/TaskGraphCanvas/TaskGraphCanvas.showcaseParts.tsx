import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { rollupTaskGraphStatus } from "../../lib/taskGraphLayout";
import { Blocks } from "../../components/Icons";
import { dsClass } from "../../lib/internal";
import { InspectorShell } from "../InspectorShell";
import shellStyles from "../InspectorShell/InspectorShell.module.css";
import { TaskGraphCard, TaskGraphStepLine } from "../TaskGraphCard";
import { TaskGraphDetail } from "../TaskGraphDetail";
import { TaskGraphPanel, TaskGraphSection } from "../TaskGraphSection";
import { TaskGraphCanvas } from "./TaskGraphCanvas";
import { GRAPHS, STATUS, type DemoGraph, type DemoTask } from "./TaskGraphCanvas.showcaseData";

// Story compositions shared by the task graph block showcases: the same wiring
// the product container does (selection state, copy, card per node).

type Locale = ShowcaseRenderContext["locale"];
export type DemoGraphId = keyof typeof GRAPHS;

const COPY = {
  "en-US": { tab: "Tasks", worker: (n: number) => `Worker ${n}`, unassigned: "Not assigned", panel: "Task graph", empty: "No tasks yet", graphs: (n: number, r: number) => `${n} graphs${r ? ` · ${r} running` : ""}`, done: (d: number, n: number) => `${d}/${n} done`, assignee: "Assignee", model: "Model", time: "Time", now: "Now", after: "After", next: "Next", none: "None", doc: "Task document", open: "Open", talk: "View conversation", blocked: "An earlier task failed" },
  "ko-KR": { tab: "작업", worker: (n: number) => `작업자 ${n}`, unassigned: "배정 전", panel: "작업 그래프", empty: "아직 작업이 없습니다", graphs: (n: number, r: number) => `그래프 ${n}개${r ? ` · 진행 중 ${r}` : ""}`, done: (d: number, n: number) => `${d}/${n} 완료`, assignee: "담당", model: "모델", time: "걸린 시간", now: "지금 하는 일", after: "앞선 작업", next: "다음 작업", none: "없음", doc: "작업 문서", open: "열기", talk: "대화 보기", blocked: "앞선 작업이 실패했습니다" },
} as const;

export const demoCopy = (locale: Locale) => COPY[locale];
/** Demo times are written "2m 05s"; Korean stories read "2분 05초". */
const localTime = (time: string | undefined, locale: Locale) =>
  time && locale === "ko-KR" ? time.replace(/(\d+)m/u, "$1분").replace(/(\d+)s/u, "$1초") : time;
export const demoCounts = (graph: DemoGraph, locale: Locale) =>
  COPY[locale].done(graph.tasks.filter((task) => task.status === "done").length, graph.tasks.length);
export const demoNodes = (graph: DemoGraph) => graph.tasks.map((task) => ({ id: task.id, status: task.status }));

/** A TaskGraphCard for one demo task. */
export function DemoCard({ task, locale, selected, onActivate }: { task: DemoTask; locale: Locale; selected?: boolean; onActivate?: (id: string) => void }) {
  const copy = COPY[locale];
  return (
    <TaskGraphCard taskId={task.id} title={task.title[locale]} status={task.status} statusLabel={STATUS[locale][task.status]}
      meta={task.worker ? `${copy.worker(task.worker)} · ${task.model}` : copy.unassigned} time={localTime(task.time, locale)}
      step={task.step?.[locale]} selected={selected} opensDialog={Boolean(task.worker)} onActivate={onActivate} />
  );
}

/** TaskGraphDetail for one demo task (facts, links, document tile, conversation). */
export function DemoDetail({ graph, task, locale, onSelect }: { graph: DemoGraph; task: DemoTask; locale: Locale; onSelect?: (id: string) => void }) {
  const copy = COPY[locale];
  const titleOf = (id: string) => ({ id, title: graph.tasks.find((item) => item.id === id)!.title[locale] });
  return (
    <TaskGraphDetail
      title={task.title[locale]} status={task.status} statusLabel={STATUS[locale][task.status]}
      notice={task.reason ? { tone: "error", message: task.reason[locale] } : task.status === "blocked" ? { tone: "warning", message: copy.blocked } : undefined}
      facts={[
        { id: "assignee", label: copy.assignee, value: task.worker ? copy.worker(task.worker) : copy.unassigned },
        ...(task.model ? [{ id: "model", label: copy.model, value: task.model }] : []),
        ...(task.time ? [{ id: "time", label: copy.time, value: localTime(task.time, locale) }] : []),
        ...(task.status === "running" && task.step ? [{ id: "now", label: copy.now, value: <TaskGraphStepLine step={task.step[locale]} /> }] : []),
      ]}
      relations={[
        { id: "after", label: copy.after, emptyLabel: copy.none, tasks: graph.edges.filter((edge) => edge.to === task.id).map((edge) => titleOf(edge.from)) },
        { id: "next", label: copy.next, emptyLabel: copy.none, tasks: graph.edges.filter((edge) => edge.from === task.id).map((edge) => titleOf(edge.to)) },
      ]}
      onSelectTask={onSelect}
      document={{ title: copy.doc, meta: `TASK-${task.id.toUpperCase()} · ${STATUS[locale][task.status]}`, actionLabel: copy.open, onOpen: () => undefined }}
      conversation={task.worker ? { label: copy.talk, onOpen: () => undefined } : undefined}
    />
  );
}

const firstSelection = (graph: DemoGraph) =>
  graph.tasks.find((task) => task.status === "running")?.id ?? graph.tasks.find((task) => task.status === "failed")?.id ?? graph.tasks[0]?.id ?? null;

/** One graph with selection: canvas (or lanes) plus the selected task's detail. */
export function DemoGraphView({ graph, locale, orientation = "auto", detail = true }: { graph: DemoGraph; locale: Locale; orientation?: "auto" | "horizontal" | "vertical"; detail?: boolean }) {
  const [selected, setSelected] = useState(() => firstSelection(graph));
  const task = graph.tasks.find((item) => item.id === selected);
  return (
    <>
      <TaskGraphCanvas nodes={demoNodes(graph)} edges={graph.edges} label={graph.title[locale]} selectedId={selected}
        onSelect={setSelected} orientation={orientation}
        renderNode={(id) => <DemoCard task={graph.tasks.find((item) => item.id === id)!} locale={locale} selected={id === selected} onActivate={setSelected} />} />
      {detail && task ? <DemoDetail graph={graph} task={task} locale={locale} onSelect={setSelected} /> : null}
    </>
  );
}

const ORDER = ["running", "failed", "pending", "done", "cancelled"];

/** The Tasks tab body for several graphs: TaskGraphPanel with one TaskGraphSection per graph. */
export function DemoPanel({ graphIds, locale, orientation = "auto" }: { graphIds: DemoGraphId[]; locale: Locale; orientation?: "auto" | "horizontal" | "vertical" }) {
  const copy = COPY[locale];
  const graphs = graphIds.map((id) => GRAPHS[id] as DemoGraph)
    .map((graph) => ({ graph, status: rollupTaskGraphStatus(graph.tasks.map((task) => task.status)) }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const [open, setOpen] = useState(() => new Set(graphs.filter(({ status }) => status === "running" || status === "failed").map(({ graph }) => graph.id)));
  const single = graphs.length === 1 ? graphs[0]!.graph : undefined;
  // Inside the real inspector frame, so insets resolve as in the app (--inspector-inline-padding).
  return (
    <InspectorShell activeTab="tasks" tabs={[{ id: "tasks", label: copy.tab, icon: <Blocks size="md" /> }]} onTabChange={() => undefined}
      className={dsClass(shellStyles.fixture)}>
    <TaskGraphPanel title={copy.panel} icon={<Blocks size="md" />} emptyLabel={copy.empty} empty={graphs.length === 0}
      description={single?.title[locale]}
      headerMeta={single ? demoCounts(single, locale) : graphs.length ? copy.graphs(graphs.length, graphs.filter(({ status }) => status === "running").length) : undefined}>
      {graphs.map(({ graph, status }) => (
        <TaskGraphSection key={graph.id} graphId={graph.id} title={graph.title[locale]} status={status} meta={demoCounts(graph, locale)}
          collapsible={!single} open={open.has(graph.id)}
          onToggle={() => setOpen((current) => { const next = new Set(current); if (next.has(graph.id)) next.delete(graph.id); else next.add(graph.id); return next; })}>
          <DemoGraphView graph={graph} locale={locale} orientation={orientation} />
        </TaskGraphSection>
      ))}
    </TaskGraphPanel>
    </InspectorShell>
  );
}
