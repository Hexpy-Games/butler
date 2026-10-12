import { Bot, ListRow, ProviderLogo, SetupWizardStepAction, Stack, type ProviderLogoName } from "@/butler-ds";
import type { AgentImportCounts } from "../settings/agentImportApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const LOGOS: Record<string, ProviderLogoName> = { "claude-code": "claude", codex: "openai", opencode: "opencode" };

/** Import ① after the run: one row per imported tool, what it added and what still needs a key. */
export function FirstRunAgentResult({ flow }: { flow: FirstRunFlow }) {
  const text = flow.copy.import;
  const { sources, bySource } = flow.agentImport;
  const line = (counts: AgentImportCounts) => [
    counts.instructions + counts.servers > 0 ? text.agentsAdded(counts.instructions, counts.servers) : text.agentsNothing,
    counts.needs_secret > 0 ? text.agentsNeedsKey(counts.needs_secret) : "",
  ].filter(Boolean).join(" · ");
  return (
    <FirstRunStepCard flow={flow} contentKey="agents:done" title={text.agentsDoneTitle}
      titleId="first-run-agents-done-title" onBack={flow.backFromImport}
      actions={<SetupWizardStepAction forward onClick={flow.toBrowsers}>{flow.copy.next}</SetupWizardStepAction>}
    >
      <Stack gap="sm" role="status">
        {(sources ?? []).filter((source) => bySource[source.key]).map((source) => (
          <ListRow key={source.key} icon={LOGOS[source.key] ? <ProviderLogo name={LOGOS[source.key]!} /> : <Bot size="md" />}
            title={source.name} description={line(bySource[source.key]!)} />
        ))}
      </Stack>
    </FirstRunStepCard>
  );
}
