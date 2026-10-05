import { useEffect, useMemo, useState } from "react";
import { appCopy, setAppCopyLanguage } from "@/app/copy";
import { HARNESS_SUMMARY } from "@/app/fixtures";
import { useButlerStore } from "@/app/store";
import type { SessionSummaryView, SessionView } from "@/app/types";
import { appShellTheme } from "@/app/utils";
import {
  AdaptivePanelResizeHandle, AdaptiveShell, AdaptiveShellInspector, AdaptiveShellWorkspace, Blocks, Clock3, FileText,
  InspectorShell, ListFilter, Stack, Wallpaper,
} from "@/butler-ds";
import { SummaryPanel } from "@/components/inspector/SummaryPanel";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog";
import { usePanelResize } from "@/hooks/usePanelResize";
import { TASK_GRAPH_COPY, type ProposalLocale, type Scenario } from "./copy";
import { scenarioGraphs, sessionIdOf } from "./fixture";
import { taskSessionView } from "./linked";
import { STAGE_MESSAGE, stateFromQuery, WALLPAPERS, type StageState } from "./state";
import { TaskGraphSection } from "./TaskGraphSection";

const PROGRESS: Record<ProposalLocale, string[]> = {
  "ko-KR": ["요청 정리", "작업 나누기", "작업자에게 맡기기"],
  "en-US": ["Read the request", "Split the work", "Hand tasks to workers"],
};

/** The real SummaryPanel's input (rendered unchanged in the Summary tab). */
function summaryFixture(locale: ProposalLocale, scenario: Scenario): SessionSummaryView {
  const labels = scenario === "empty" ? PROGRESS[locale].slice(0, 2) : PROGRESS[locale];
  return {
    latest_progress: {
      safe_progress_rows: labels.map((label, i) => ({
        id: `p${i}`, kind: "work_block", work_block_id: `w${i}`, work_block_label: label,
        state: i === labels.length - 1 && scenario === "empty" ? "running" : "completed", safe_label: label,
      })),
    },
  } as SessionSummaryView;
}

// The app persists the inspector width through useAppBootstrap -> writeCachedAppUiState
// (right_panel_width). The proposal keeps it in this frame's localStorage instead.
const WIDTH_KEY = "butler-proposal-task-graph:right-panel-width";

/**
 * The framed preview (an iframe, so media queries resolve at the chosen width): the real AdaptiveShell
 * with the real inspector resize handle and SessionObserverDialog, stores seeded from fixtures.
 */
export function TaskGraphStage() {
  const [state, setState] = useState<StageState>(() => stateFromQuery(new URLSearchParams(location.search)));
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get("tab") ?? "tasks");
  const panel = usePanelResize({ leftOpen: false, setLeftOpen: () => {} });

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== STAGE_MESSAGE) return;
      setState(event.data.state as StageState);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.body.dataset.motion = state.motion;
  }, [state.theme, state.motion]);

  // Width: restore once, then remember every change.
  useEffect(() => {
    let saved = Number.NaN;
    try { saved = Number(localStorage.getItem(WIDTH_KEY)); } catch { /* private mode */ }
    if (saved > 0) useButlerStore.getState().setRightPanelWidth(saved);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(panel.rightPanelWidth)); } catch { /* private mode */ }
  }, [panel.rightPanelWidth]);

  setAppCopyLanguage(state.locale);
  const graphs = useMemo(() => scenarioGraphs(state.scenario), [state.scenario]);
  const harness = new URLSearchParams(location.search).get("summary") === "harness";
  const summary = useMemo(() => (harness ? HARNESS_SUMMARY : summaryFixture(state.locale, state.scenario)), [harness, state.locale, state.scenario]);

  // Seed each worker's session view; the dialog's refresh is a no-op without a gateway.
  useEffect(() => {
    const views: Record<string, SessionView> = {};
    for (const node of graphs.flatMap((graph) => graph.nodes)) {
      const view = taskSessionView(node, state.locale);
      if (view) views[sessionIdOf(node)!] = view;
    }
    useButlerStore.setState((current) => ({
      sessionViews: { ...current.sessionViews, ...views },
      settings: { ...current.settings, appearance_theme: state.theme },
      refreshSessionObserver: async () => true,
      cancelObservedSteward: async () => true,
      resumeObservedSteward: async () => true,
    }));
  }, [graphs, state.locale, state.theme]);

  // Proposal copy of Inspector's tab list (components/inspector/Inspector.tsx) with one new tab,
  // "tasks", after Summary. Every other tab keeps its id, label, icon and order.
  const tabs = [
    { id: "summary", label: appCopy.inspector.tabs.summary, icon: <ListFilter size="md" /> },
    { id: "tasks", label: TASK_GRAPH_COPY[state.locale].tab, icon: <Blocks size="md" /> },
    { id: "artifacts", label: appCopy.inspector.tabs.artifacts, icon: <FileText size="md" /> },
    { id: "automations", label: appCopy.inspector.tabs.automations, icon: <Clock3 size="md" /> },
  ];
  const settings = useButlerStore((store) => store.settings);

  return (
    <>
      <Wallpaper source={WALLPAPERS[state.wallpaper]} scope="viewport" />
      <AdaptiveShell
        ref={panel.shellRef}
        theme={appShellTheme({ ...settings, appearance_theme: state.theme })}
        chromeEnvironment="browser"
        platform="browser"
        leftOpen={false}
        rightOpen
        resizing={Boolean(panel.resizingPanel)}
        transparentWorkspace
        UNSAFE_style={panel.panelStyle}
      >
        <AdaptiveShellWorkspace><Stack fill gap="none">{null}</Stack></AdaptiveShellWorkspace>
        <AdaptiveShellInspector data-test-class="right-panel-slot" open>
          <InspectorShell id="butler-right-inspector" activeTab={tab} tabs={tabs} onTabChange={setTab}>
            {tab === "summary" ? <SummaryPanel status={{ label: "", tone: "neutral" } as never} summary={summary} /> : null}
            {tab === "tasks" ? (
              <TaskGraphSection key={`${state.scenario}:${state.locale}`} graphs={graphs} locale={state.locale} variant={state.variant} />
            ) : null}
          </InspectorShell>
        </AdaptiveShellInspector>
        <AdaptivePanelResizeHandle
          aria-label={appCopy.titlebar.resizeRightPanel}
          aria-orientation="vertical"
          aria-controls="butler-right-inspector"
          aria-valuemax={panel.rightMax}
          aria-valuemin={panel.rightMin}
          aria-valuenow={panel.rightPanelWidth}
          data-test-class="panel-resize-handle right-panel-resize-handle"
          side="right"
          onKeyDown={(event) => panel.handlePanelResizeKeyDown("right", event)}
          onPointerDown={(event) => panel.beginPanelResize("right", event)}
        />
      </AdaptiveShell>
      <SessionObserverDialog />
    </>
  );
}
