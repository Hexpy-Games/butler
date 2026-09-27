import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { WorkerActivityRow } from "../WorkerActivityRow";
import { WorkerActivityPanel } from "./WorkerActivityPanel";

// #region recipe: Workers above the composer
function WorkersPanel() {
  return (
    <WorkerActivityPanel heading="Workers" collapsedSummary="Worker 1 Executing: Reading project files and 1 more" items={[
      { id: "w1", title: "Worker 1", description: "Reading project files.", meta: "Executing", phase: "executing" },
      { id: "w2", title: "Worker 2", description: "Reviewing the evidence.", meta: "Verifying", phase: "verifying", depth: 1 },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The composer-attached list of active workers, collapsible to a one-line summary.",
  whenToUse: ["Workers run during the current turn"],
  whenNotToUse: [
    { when: "Plan steps", use: "TodoProgressPanel" },
    { when: "Workers in the inspector", use: "InspectorPanel" },
  ],
  recipes: [{ name: "Workers above the composer", description: "Pass it as ComposerCard adjunct; nested workers use depth.", render: () => <WorkersPanel /> }],
  doDont: [
    {
      do: { caption: "A summary line when folded keeps the composer usable.", render: () => <WorkersPanel /> },
      dont: { caption: "Loose worker rows push the composer down.", render: () => <Stack gap="xs"><WorkerActivityRow id="a" title="Worker 1" phase="executing" /><WorkerActivityRow id="b" title="Worker 2" phase="verifying" /></Stack> },
    },
  ],
  content: ["Summaries name the first worker and count the rest (… and 1 more / … 외 1개)."],
  accessibility: ["It renders nothing without items; the header toggle exposes aria-expanded."],
  tokens: ["--worker-panel-bg", "--composer-glass-bg", "--worker-active"],
};
