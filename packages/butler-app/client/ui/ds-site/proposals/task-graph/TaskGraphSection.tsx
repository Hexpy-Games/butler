import { useEffect, useMemo, useState } from "react";
import { useButlerStore } from "@/app/store";
import type { ProjectDashboardDocument } from "@/app/types";
import { Blocks, EmptyLine, InspectorInset, Section, Stack, Typo } from "@/butler-ds";
import { ProjectDocumentDialog } from "@/components/management/ProjectDocumentDialog";
import { TASK_GRAPH_COPY, type ProposalLocale, type Variant } from "./copy";
import { sessionIdOf, type TaskGraph } from "./fixture";
import { GraphCanvas } from "./GraphCanvas";
import { GraphLanes } from "./GraphLanes";
import { defaultSelection, indexGraph, layeredColumns } from "./layout";
import { taskDocument } from "./linked";
import { elapsedSeconds, TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";

/** One clock per graph; ticks only while a task runs and the page is visible (no idle work). */
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

function usePhone() {
  const query = "(width <= 640px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

export interface TaskGraphSectionProps {
  graph: TaskGraph;
  locale: ProposalLocale;
  variant: Variant;
}

/** The Tasks tab: header with counts, the graph (canvas or lanes), then the selected task. */
export function TaskGraphSection({ graph, locale, variant }: TaskGraphSectionProps) {
  const copy = TASK_GRAPH_COPY[locale];
  const index = useMemo(() => indexGraph(graph), [graph]);
  const columns = useMemo(() => layeredColumns(graph, index), [graph, index]);
  const [selected, setSelected] = useState(() => defaultSelection(graph));
  const [loadedAt] = useState(() => Date.now());
  const now = useNow(graph.nodes.some((node) => node.status === "running"));
  const phone = usePhone();
  const openSession = useButlerStore((state) => state.openSessionObserver);
  const [taskDoc, setTaskDoc] = useState<ProjectDashboardDocument | null>(null);
  useEffect(() => setSelected(defaultSelection(graph)), [graph]);

  const openConversation = (id: string) => {
    const session = sessionIdOf(index.byId.get(id)!);
    if (session) openSession(session);
  };
  // Variant A: a card click selects and opens the worker's conversation; arrow keys only select.
  const activate = (id: string) => {
    setSelected(id);
    if (variant === "open") openConversation(id);
  };

  const done = graph.nodes.filter((node) => node.status === "completed").length;
  const failed = graph.nodes.filter((node) => node.status === "failed").length;
  const cancelled = graph.nodes.filter((node) => node.status === "cancelled").length;
  // Exact totals: cancelled tasks stay counted and reachable (work model §5).
  const counts = [copy.doneCount(done, graph.nodes.length), failed ? copy.failedCount(failed) : null, cancelled ? copy.cancelledCount(cancelled) : null]
    .filter(Boolean).join(" · ");
  const selectedNode = selected ? index.byId.get(selected) : undefined;

  const renderCard = (id: string) => {
    const node = index.byId.get(id)!;
    return (
      <TaskCard node={node} copy={copy} locale={locale} selected={id === selected}
        elapsed={elapsedSeconds(node, now, loadedAt)} onActivate={activate} />
    );
  };
  const view = { graph, index, columns, label: copy.graphLabel, selected, renderCard, onSelect: setSelected };

  return (
    <Stack gap="md" data-test-class="task-graph-section">
      {/* Header and canvas touch: the canvas scrolls edge to edge, its cards line up with the header. */}
      <Stack gap="none">
        <InspectorInset>
          <Section
            title={copy.title}
            icon={<Blocks size="md" />}
            actions={graph.nodes.length ? <Typo.Caption tone="tertiary" numeric="tabular">{counts}</Typo.Caption> : null}
            gap="sm"
          >
            {graph.nodes.length === 0 ? <EmptyLine message={copy.empty} /> : null}
            {graph.nodes.length > 0 && phone ? <GraphLanes {...view} /> : null}
          </Section>
        </InspectorInset>
        {graph.nodes.length > 0 && !phone ? <GraphCanvas {...view} /> : null}
      </Stack>
      {selectedNode ? (
        <TaskDetail node={selectedNode} index={index} copy={copy} locale={locale}
          elapsed={elapsedSeconds(selectedNode, now, loadedAt)} onSelect={setSelected}
          onOpenConversation={sessionIdOf(selectedNode) ? () => openConversation(selectedNode.id) : undefined}
          onOpenDocument={() => setTaskDoc(taskDocument(selectedNode, graph, copy, locale))} />
      ) : null}
      <ProjectDocumentDialog document={taskDoc} onClose={() => setTaskDoc(null)} />
    </Stack>
  );
}
