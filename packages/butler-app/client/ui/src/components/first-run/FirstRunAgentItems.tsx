import { appCopy } from "@/app/copy";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, SetupWizardStepAction, Switch, Typo } from "@/butler-ds";
import type { AgentImportSource } from "../settings/agentImportApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import { agentItems } from "./useAgentPicks";
import type { FirstRunFlow } from "./useFirstRunFlow";

/**
 * Import ①, one page per chosen tool: its instruction file and each MCP server as switches, all on at
 * first. Next opens the next tool; the last page imports every tool's choice (or moves on when none is on).
 */
export function FirstRunAgentItems({ flow, source }: { flow: FirstRunFlow; source: AgentImportSource }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const { agentPicks: picks, agentImport: imp } = flow;
  const index = picks.page;
  const total = picks.tools.length;
  const choice = picks.choiceOf(source);
  const items = agentItems(source);
  const action = index < total - 1
    ? <SetupWizardStepAction forward onClick={() => picks.open(index + 1)}>{text.next}</SetupWizardStepAction>
    : picks.anyOn
      ? <SetupWizardStepAction forward disabled={imp.busy} onClick={() => void picks.importAll()}>{imp.busy ? text.importing : text.importAction}</SetupWizardStepAction>
      : <SetupWizardStepAction forward onClick={flow.toBrowsers}>{text.next}</SetupWizardStepAction>;
  const fileReason = source.instructions_error === "too_large" ? text.itemFileTooLarge
    : source.instructions_error ? text.itemFileUnreadable : text.itemFileEmpty;
  return (
    <FirstRunStepCard flow={flow} contentKey={`agents:${source.key}`} title={text.agentItemsTitle(source.name)}
      titleId="first-run-agent-items-title" description={text.agentItemsProgress(source.name, index + 1, total)}
      onBack={() => picks.open(index - 1)} actions={action}
    >
      <FieldGroup>
        {items.instructions[0] || source.instructions_file ? (
          <ItemSwitch id={`${source.key}-instructions`} label={text.itemInstructions} detail={items.instructions[0] ?? source.instructions_file ?? ""}
            on={Boolean(items.instructions[0]) && choice.instructions} busy={imp.busy}
            blocked={items.instructions[0] ? undefined : fileReason} onToggle={() => picks.toggleInstructions(source)} item="instructions" />
        ) : null}
        {items.servers.map((server) => (
          <ItemSwitch key={server.name} id={`${source.key}-server-${server.name}`} label={server.name}
            detail={server.needs_secret ? `${text.itemServer} · ${text.itemNeedsKey}` : text.itemServer}
            on={choice.servers.includes(server.name)} busy={imp.busy} onToggle={() => picks.toggleServer(source, server.name)} item={server.name} />
        ))}
      </FieldGroup>
      {imp.error ? <Typo.Caption role="alert" tone="danger">{appCopy.settings.agentImport.failed}</Typo.Caption> : null}
    </FirstRunStepCard>
  );
}

function ItemSwitch({ id, label, detail, on, busy, blocked, onToggle, item }: {
  id: string; label: string; detail: string; on: boolean; busy: boolean; blocked?: string; onToggle: () => void; item: string;
}) {
  const control = `first-run-agent-item-${id}`;
  return (
    <Field orientation="horizontal" data-agent-import-item={item}>
      <Switch id={control} checked={on} disabled={busy} disabledReason={blocked} aria-describedby={`${control}-detail`} onCheckedChange={blocked ? undefined : onToggle} />
      <FieldContent>
        <FieldLabel htmlFor={control}>{label}</FieldLabel>
        <FieldDescription id={`${control}-detail`}>{detail}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
