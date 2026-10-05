import { useEffect, useMemo, useState } from "react";
import { appCopy, setAppCopyLanguage } from "@/app/copy";
import { HARNESS_SUMMARY } from "@/app/fixtures";
import type { SessionSummaryView } from "@/app/types";
import { Box, Clock3, FileText, InspectorShell, ListFilter, Stack, Wallpaper } from "@/butler-ds";
import { SummaryPanel } from "@/components/inspector/SummaryPanel";
import type { ProposalLocale, Scenario } from "./copy";
import { scenarioGraph } from "./fixture";
import { STAGE_MESSAGE, stateFromQuery, WALLPAPERS, type StageState } from "./state";
import { TaskGraphSection } from "./TaskGraphSection";

const PROGRESS: Record<ProposalLocale, string[]> = {
  "ko-KR": ["요청 정리", "작업 나누기", "작업자에게 맡기기"],
  "en-US": ["Read the request", "Split the work", "Hand tasks to workers"],
};

/** The real SummaryPanel's input: a few finished work blocks (it renders them unchanged). */
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

function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia("(width <= 640px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(width <= 640px)");
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * The framed preview (an iframe, so viewport media queries resolve at the chosen width): the
 * wallpaper with the inspector docked at the app's default width (376px), or full width on a phone.
 */
export function TaskGraphStage() {
  const [state, setState] = useState<StageState>(() => stateFromQuery(new URLSearchParams(location.search)));
  const phone = usePhone();
  const [tab, setTab] = useState("summary");

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

  setAppCopyLanguage(state.locale);
  const graph = useMemo(() => scenarioGraph(state.scenario), [state.scenario]);
  // `summary=harness` feeds the app's visual-harness summary, for side-by-side fidelity checks.
  const harness = new URLSearchParams(location.search).get("summary") === "harness";
  const summary = useMemo(() => (harness ? HARNESS_SUMMARY : summaryFixture(state.locale, state.scenario)), [harness, state.locale, state.scenario]);
  const tabs = [
    { id: "summary", label: appCopy.inspector.tabs.summary, icon: <ListFilter size="md" /> },
    // The tabs Inspector shows outside developer mode, in its order.
    { id: "artifacts", label: appCopy.inspector.tabs.artifacts, icon: <FileText size="md" /> },
    { id: "automations", label: appCopy.inspector.tabs.automations, icon: <Clock3 size="md" /> },
  ];

  return (
    <Stack align="row" justify="end" gap="none" UNSAFE_style={{ height: "100dvh" }}>
      <Wallpaper source={WALLPAPERS[state.wallpaper]} scope="viewport" />
      <Stack gap="none" shrink={false} UNSAFE_style={{ width: phone ? "100%" : 376, height: "100dvh", "--adaptive-viewport-block-size": phone ? "calc(100dvh - var(--titlebar-height))" : "100dvh" }}>
        {/* Phone: the drawer sits under the app titlebar row (its panel toggle is app chrome, not shown). */}
        {phone ? <Box surface="base"><Stack gap="none" UNSAFE_style={{ height: "var(--titlebar-height)" }}>{null}</Stack></Box> : null}
        <InspectorShell activeTab={tab} tabs={tabs} onTabChange={setTab}>
          {tab === "summary" ? (
            <>
              <SummaryPanel status={{ label: "", tone: "neutral" } as never} summary={summary} />
              <TaskGraphSection key={`${state.scenario}:${state.locale}`} graph={graph} locale={state.locale} variant={state.variant} />
            </>
          ) : null}
        </InspectorShell>
      </Stack>
    </Stack>
  );
}
