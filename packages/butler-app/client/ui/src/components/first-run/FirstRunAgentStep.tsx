import { appCopy } from "@/app/copy";
import {
  EmptyLine, Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, Inline, SetupWizardStepAction, Spinner, Switch, Tooltip, Typo,
} from "@/butler-ds";
import type { AgentImportSource } from "../settings/agentImportApi";
import { FirstRunAgentItems } from "./FirstRunAgentItems";
import { FirstRunAgentResult } from "./FirstRunAgentResult";
import { FirstRunStepCard } from "./FirstRunStepCard";
import { importable } from "./useAgentPicks";
import type { FirstRunFlow } from "./useFirstRunFlow";

/**
 * Import ①: the detected AI tools as switches, on when they hold something. Next opens one page per
 * chosen tool to pick its items; Skip goes straight to the browsers. The result is its own screen.
 */
export function FirstRunAgentStep({ flow }: { flow: FirstRunFlow }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const { agentImport: pick, agentPicks: picks } = flow;
  if (flow.agentsDone) return <FirstRunAgentResult flow={flow} />;
  if (picks.current) return <FirstRunAgentItems flow={flow} source={picks.current} />;
  const chosen = picks.chosen;
  const empty = pick.sources !== null && !pick.error && !pick.sources.some(importable);
  const next = <SetupWizardStepAction forward disabled={!empty && picks.tools.length === 0}
    onClick={() => (empty ? flow.toBrowsers() : picks.open(0))}>{text.next}</SetupWizardStepAction>;
  return (
    <FirstRunStepCard flow={flow} contentKey="agents" title={text.agentsTitle}
      titleId="first-run-agents-title" description={text.agentsBody} onBack={flow.backFromImport}
      actions={empty ? next : <>
        <SetupWizardStepAction onClick={flow.toBrowsers}>{text.skip}</SetupWizardStepAction>
        <Tooltip label={picks.tools.length === 0 ? text.pickOne : undefined}>{next}</Tooltip>
      </>}
    >
      {pick.sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{text.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={text.agentsEmpty} /> : (
        <FieldGroup>
          {pick.sources.map((source) => <SourceSwitch key={source.key} source={source} on={chosen.includes(source.key)}
            busy={pick.busy} onToggle={() => picks.toggleTool(source.key)} />)}
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
