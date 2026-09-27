import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Activity, CheckCircle2 } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { WorkerActivityRow } from "./WorkerActivityRow";

export const meta: ShowcaseMeta = {
  title: "WorkerActivityRow",
  category: "Conversation & Activity",
  tags: ["worker", "activity", "phase", "success", "motion"],
  status: "stable",
};

const labels = {
  "en-US": { title: "Implementation worker", running: "Running validation", done: "Finished", replay: "Replay", stop: "Stop", rail: "Worker phases" },
  "ko-KR": { title: "구현 워커", running: "검증 실행 중", done: "완료", replay: "다시 재생", stop: "중지", rail: "워커 단계" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const phases = ["planning", "executing", "verifying", "complete"];

function CompleteStory({ context }: { context: ShowcaseRenderContext }) {
  const [step, setStep] = useState(2);
  const phase = phases[step]!;
  const done = phase === "complete";
  const replay = () => {
    setStep(2);
    window.setTimeout(() => setStep(3), 600);
  };
  return (
    <Stack gap="md">
      <WorkerActivityRow
        id="worker-complete-story"
        icon={done ? <CheckCircle2 size="md" /> : <Activity size="md" />}
        title={text(context).title}
        description={done ? text(context).done : text(context).running}
        phase={phase}
        phaseRailLabel={text(context).rail}
      />
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={replay}>{text(context).replay}</Button>
      </Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Completes", states: ["success"], render: (context) => <CompleteStory context={context} /> },
  {
    name: "Running with action",
    render: (context) => (
      <WorkerActivityRow id="worker-running-story" icon={<Activity size="md" />} title={text(context).title}
        description={text(context).running} phase="executing" phaseRailLabel={text(context).rail}
        actions={[<Button size="xs" variant="borderless" key="stop">{text(context).stop}</Button>]} />
    ),
  },
];
