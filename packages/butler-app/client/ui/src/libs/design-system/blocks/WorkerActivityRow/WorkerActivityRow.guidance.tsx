import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Activity } from "../../components/Icons";
import { ListRow } from "../ListRow";
import { WorkerActivityRow } from "./WorkerActivityRow";

// #region recipe: Running worker with a stop action
function RunningWorker() {
  return (
    <WorkerActivityRow id="worker-1" icon={<Activity size="md" />} title="Implementation worker" description="Running validation"
      phase="executing" phaseRailLabel="Worker phases" actions={[<Button key="stop" size="xs" variant="borderless" text="Stop" />]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One worker's row: icon aligned with the title, description, phase rail and a success pulse on completion.",
  whenToUse: ["Show a delegated worker's progress (inspector, composer panel)"],
  whenNotToUse: [
    { when: "A list of workers above the composer", use: "WorkerActivityPanel" },
    { when: "A generic data row", use: "ListRow" },
  ],
  recipes: [{ name: "Running worker with a stop action", description: "phase drives the rail; actions trail the row.", render: () => <RunningWorker /> }],
  doDont: [
    {
      do: { caption: "The phase rail shows where the worker is.", render: () => <RunningWorker /> },
      dont: { caption: "A ListRow hides the phase and the completion moment.", render: () => <ListRow icon={<Activity size="md" />} title="Implementation worker" meta="executing" /> },
    },
  ],
  content: ["Descriptions are present progressive while running, past tense when complete."],
  accessibility: ["phaseRailLabel names the rail; the completion pulse is decorative (reduced motion keeps color only)."],
  tokens: ["--worker-active", "--color-success", "--motion-deliberate", "--motion-scale-menu"],
};
