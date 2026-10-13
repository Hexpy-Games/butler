import { appCopy } from "@/app/copy";
import { ChoiceCardList, ChoiceCheckCard, EmptyLine, Inline, SetupWizardStepAction, Spinner, Tooltip, Typo } from "@/butler-ds";
import { AgentGlyph } from "./AgentGlyph";
import { FirstRunAgentItems } from "./FirstRunAgentItems";
import { FirstRunAgentResult } from "./FirstRunAgentResult";
import { FirstRunStepCard } from "./FirstRunStepCard";
import { importable } from "./useAgentPicks";
import type { FirstRunFlow } from "./useFirstRunFlow";

/**
 * Import: the detected AI tools as pick cards, picked when they hold something. Next opens one page per
 * chosen tool to pick its items; Skip goes straight to the finish. The result is its own screen.
 */
export function FirstRunAgentStep({ flow }: { flow: FirstRunFlow }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const { agentImport: pick, agentPicks: picks } = flow;
  if (flow.agentsDone) return <FirstRunAgentResult flow={flow} />;
  if (picks.current) return <FirstRunAgentItems flow={flow} source={picks.current} />;
  const chosen = picks.chosen;
  const empty = pick.sources !== null && !pick.error && !pick.sources.some(importable);
  const next = <SetupWizardStepAction forward disabled={!empty && picks.tools.length === 0}
    onClick={() => (empty ? flow.finishImport() : picks.open(0))}>{text.next}</SetupWizardStepAction>;
  return (
    <FirstRunStepCard flow={flow} contentKey="agents" title={text.agentsTitle}
      titleId="first-run-agents-title" description={text.agentsBody} onBack={flow.backFromImport}
      actions={empty ? next : <>
        <SetupWizardStepAction onClick={flow.finishImport}>{text.skip}</SetupWizardStepAction>
        <Tooltip label={picks.tools.length === 0 ? text.pickOne : undefined}>{next}</Tooltip>
      </>}
    >
      {pick.sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{text.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={text.agentsEmpty} /> : (
        <ChoiceCardList role="group" aria-labelledby="first-run-agents-title">
          {pick.sources.map((source) => (
            <ChoiceCheckCard key={source.key} data-agent-import-source={source.key} checked={importable(source) && chosen.includes(source.key)}
              disabled={pick.busy} disabledReason={importable(source) ? undefined : appCopy.settings.agentImport.found(false, 0)}
              icon={<AgentGlyph sourceKey={source.key} />} title={source.name}
              description={appCopy.settings.agentImport.found(source.instructions, source.servers)} onCheckedChange={() => picks.toggleTool(source.key)} />
          ))}
        </ChoiceCardList>
      )}
      {pick.error ? <Typo.Caption role="alert" tone="danger">{appCopy.settings.agentImport.failed}</Typo.Caption> : null}
    </FirstRunStepCard>
  );
}
