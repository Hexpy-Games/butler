import { useState } from "react";
import { appCopy } from "@/app/copy";
import {
  EmptyLine, Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, Inline, SetupWizardStepAction, Spinner, Switch, Tooltip, Typo,
} from "@/butler-ds";
import type { AgentImportSource } from "../settings/agentImportApi";
import { FirstRunAgentResult } from "./FirstRunAgentResult";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const importable = (source: AgentImportSource) => source.instructions || source.servers > 0;

/**
 * Import ①: the detected AI tools as switches, on when they hold something. Next imports the chosen
 * tools and opens the per-tool result; Skip goes straight to the browsers.
 */
export function FirstRunAgentStep({ flow }: { flow: FirstRunFlow }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const pick = flow.agentImport;
  const [picked, setPicked] = useState<string[] | null>(null);
  if (flow.agentsDone) return <FirstRunAgentResult flow={flow} />;
  const chosen = picked ?? pick.sources?.filter(importable).map((source) => source.key) ?? [];
  const toggle = (key: string) => setPicked(chosen.includes(key) ? chosen.filter((entry) => entry !== key) : [...chosen, key]);
  const empty = pick.sources !== null && !pick.error && !pick.sources.some(importable);
  const next = <SetupWizardStepAction forward disabled={pick.busy || (!empty && chosen.length === 0)}
    onClick={() => (empty ? flow.toBrowsers() : void pick.run(chosen))}>{pick.busy ? text.importing : text.next}</SetupWizardStepAction>;
  return (
    <FirstRunStepCard flow={flow} contentKey="agents" title={text.agentsTitle}
      titleId="first-run-agents-title" description={text.agentsBody} onBack={flow.backFromImport}
      actions={empty ? next : <>
        <SetupWizardStepAction disabled={pick.busy} onClick={flow.toBrowsers}>{text.skip}</SetupWizardStepAction>
        <Tooltip label={chosen.length === 0 && !pick.busy ? text.pickOne : undefined}>{next}</Tooltip>
      </>}
    >
      {pick.sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{text.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={text.agentsEmpty} /> : (
        <FieldGroup>
          {pick.sources.map((source) => <SourceSwitch key={source.key} source={source} on={chosen.includes(source.key)}
            busy={pick.busy} onToggle={() => toggle(source.key)} />)}
        </FieldGroup>
      )}
      {pick.error ? <Typo.Caption role="alert" tone="danger">{appCopy.settings.agentImport.failed}</Typo.Caption> : null}
    </FirstRunStepCard>
  );
}

function SourceSwitch({ source, on, busy, onToggle }: { source: AgentImportSource; on: boolean; busy: boolean; onToggle: () => void }) {
  const found = appCopy.settings.agentImport.found(source.instructions, source.servers);
  const id = `first-run-agent-${source.key}`;
  return (
    <Field orientation="horizontal" data-agent-import-source={source.key}>
      <Switch id={id} checked={on && importable(source)} disabled={busy} disabledReason={importable(source) ? undefined : found}
        aria-describedby={`${id}-found`} onCheckedChange={onToggle} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{source.name}</FieldLabel>
        <FieldDescription id={`${id}-found`}>{found}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
