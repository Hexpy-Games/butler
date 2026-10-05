import { useEffect, useMemo, useState } from "react";
import { useButlerStore } from "@/app/store";
import type { ProjectDashboardDocument } from "@/app/types";
import { Blocks, EmptyLine, InspectorInset, Section, Stack, Typo } from "@/butler-ds";
import { ProjectDocumentDialog } from "@/components/management/ProjectDocumentDialog";
import { TASK_GRAPH_COPY, type ProposalLocale, type Variant } from "./copy";
import { sessionIdOf, type TaskGraph } from "./fixture";
import { graphCounts, graphState, orderGraphs } from "./graphs";
import { defaultSelection, indexGraph } from "./layout";
import { taskDocument } from "./linked";
import { CombinedGraphs, PickedGraph, StackedGraphs } from "./MultiGraph";
import { elapsedSeconds, TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";

/** One clock for the tab; ticks only while a task runs and the page is visible (no idle work). */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export interface TaskGraphSectionProps {
  graphs: TaskGraph[];
  locale: ProposalLocale;
  variant: Variant;
}

const LAYOUT = { stacked: StackedGraphs, picker: PickedGraph, combined: CombinedGraphs };

/** The Tasks tab: header, every graph of the conversation (by variant), the selected task's detail. */
export function TaskGraphSection({ graphs, locale, variant }: TaskGraphSectionProps) {
  const copy = TASK_GRAPH_COPY[locale];
  const ordered = useMemo(() => orderGraphs(graphs), [graphs]);
  const indexes = useMemo(() => new Map(ordered.map((graph) => [graph.id, indexGraph(graph)])), [ordered]);
  const owner = useMemo(() => new Map(ordered.flatMap((graph) => graph.nodes.map((node) => [node.id, graph.id] as const))), [ordered]);
  const first = () => ordered.map((graph) => defaultSelection(graph)).find(Boolean) ?? null;
  const [selected, setSelected] = useState<string | null>(first);
  const [loadedAt] = useState(() => Date.now());
  const now = useNow(ordered.some((graph) => graph.nodes.some((node) => node.status === "running")));
  const openSession = useButlerStore((state) => state.openSessionObserver);
  const [taskDoc, setTaskDoc] = useState<ProjectDashboardDocument | null>(null);
  useEffect(() => setSelected(first()), [ordered]);

  const selectedGraph = selected ? owner.get(selected) ?? null : null;
  const graphOf = (id: string) => ordered.find((graph) => graph.id === owner.get(id))!;
  const nodeOf = (id: string) => indexes.get(owner.get(id)!)!.byId.get(id)!;
  const openConversation = (id: string) => {
    const session = sessionIdOf(nodeOf(id));
    if (session) openSession(session);
  };
  // A card click selects and opens the worker's conversation; arrow keys only select.
  const activate = (id: string) => { setSelected(id); openConversation(id); };

  const renderCard = (id: string) => {
    const node = nodeOf(id);
    return <TaskCard node={node} copy={copy} locale={locale} selected={id === selected} elapsed={elapsedSeconds(node, now, loadedAt)} onActivate={activate} />;
  };
  const selectedNode = selected ? nodeOf(selected) : undefined;
  const detail = selectedNode ? (
    <TaskDetail node={selectedNode} index={indexes.get(selectedGraph!)!} copy={copy} locale={locale}
      elapsed={elapsedSeconds(selectedNode, now, loadedAt)} onSelect={setSelected}
      onOpenConversation={sessionIdOf(selectedNode) ? () => openConversation(selectedNode.id) : undefined}
      onOpenDocument={() => setTaskDoc(taskDocument(selectedNode, graphOf(selectedNode.id), copy, locale))} />
  ) : null;

  const running = ordered.filter((graph) => graphState(graph) === "running").length;
  const single = ordered.length === 1 ? ordered[0] : undefined;
  const Layout = LAYOUT[variant];
  return (
    <Stack gap="md" data-test-class="task-graph-section" data-variant={variant}>
      <InspectorInset>
        <Section
          title={copy.title}
          icon={<Blocks size="md" />}
          description={single ? single.title[locale] : undefined}
          actions={ordered.length ? (
            <Typo.Caption tone="tertiary" numeric="tabular">
              {single ? graphCounts(single, copy) : copy.graphsSummary(ordered.length, running)}
            </Typo.Caption>
          ) : null}
          gap="sm"
        >
          {ordered.length === 0 ? <EmptyLine message={copy.empty} /> : null}
        </Section>
      </InspectorInset>
      {ordered.length ? (
        <Layout graphs={ordered} copy={copy} locale={locale} selected={selected} selectedGraph={selectedGraph}
          detail={detail} renderCard={renderCard} onSelect={setSelected}
          onPickGraph={(graph) => setSelected(defaultSelection(graph))} />
      ) : null}
      <ProjectDocumentDialog document={taskDoc} onClose={() => setTaskDoc(null)} />
    </Stack>
  );
}
