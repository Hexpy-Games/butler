import { appCopy } from "@/app/copy";
import { ChoiceCardList, ChoiceCheckCard, FileText, Server, SetupWizardStepAction, Typo } from "@/butler-ds";
import type { AgentImportSource } from "../settings/agentImportApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import { agentItems } from "./useAgentPicks";
import type { FirstRunFlow } from "./useFirstRunFlow";

/**
 * Import, one page per chosen tool: its instruction file and each MCP server as pick cards, all picked at
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
      : <SetupWizardStepAction forward onClick={flow.finishImport}>{text.next}</SetupWizardStepAction>;
  const fileReason = source.instructions_error === "too_large" ? text.itemFileTooLarge
    : source.instructions_error ? text.itemFileUnreadable : text.itemFileEmpty;
  const file = items.instructions[0] ?? source.instructions_file ?? "";
  return (
    <FirstRunStepCard flow={flow} contentKey={`agents:${source.key}`} title={text.agentItemsTitle(source.name)}
      titleId="first-run-agent-items-title" description={text.agentItemsProgress(source.name, index + 1, total)}
      onBack={() => picks.open(index - 1)} actions={action}
    >
      <ChoiceCardList role="group" aria-labelledby="first-run-agent-items-title">
        {file ? (
          <ChoiceCheckCard data-agent-import-item="instructions" icon={<FileText size="md" />} title={text.itemInstructions}
            description={items.instructions[0] ? file : `${file} · ${fileReason}`} checked={Boolean(items.instructions[0]) && choice.instructions}
            disabled={imp.busy} disabledReason={items.instructions[0] ? undefined : fileReason} onCheckedChange={() => picks.toggleInstructions(source)} />
        ) : null}
        {items.servers.map((server) => (
          <ChoiceCheckCard key={server.name} data-agent-import-item={server.name} icon={<Server size="md" />} title={server.name}
            description={server.needs_secret ? `${text.itemServer} · ${text.itemNeedsKey}` : text.itemServer}
            checked={choice.servers.includes(server.name)} disabled={imp.busy} onCheckedChange={() => picks.toggleServer(source, server.name)} />
        ))}
      </ChoiceCardList>
      {imp.error ? <Typo.Caption role="alert" tone="danger">{appCopy.settings.agentImport.failed}</Typo.Caption> : null}
    </FirstRunStepCard>
  );
}
