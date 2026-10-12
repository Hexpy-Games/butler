import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Bot, Button, ButtonContainer, CheckCircle2, ChoiceCard, ChoiceCardList, EmptyLine, Inline, Notice, ProviderLogo,
  SetupWizardStepAction, Spinner, Typo, type ProviderLogoName,
} from "@/butler-ds";
import type { AgentImportSource } from "../settings/agentImportApi";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const LOGOS: Record<string, ProviderLogoName> = { "claude-code": "claude", codex: "openai", opencode: "opencode" };
const importable = (source: AgentImportSource) => source.instructions || source.servers > 0;

/** Import ①: other AI tools. Pick the detected tools, import, then Next. */
export function FirstRunAgentStep({ flow }: { flow: FirstRunFlow }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const copy = appCopy.settings.agentImport;
  const pick = flow.agentImport;
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { setPicked(pick.sources?.filter(importable).map(source => source.key) ?? []); }, [pick.sources]);
  const toggle = (key: string) => setPicked(prior => prior.includes(key) ? prior.filter(entry => entry !== key) : [...prior, key]);
  const done = Boolean(pick.result) && !pick.error;
  const empty = pick.sources !== null && !pick.error && !pick.sources.some(importable);
  const forward = done || empty || pick.undone;
  return (
    <FirstRunStepCard flow={flow} contentKey="agents" title={text.agentsTitle}
      titleId="first-run-agents-title" description={text.agentsBody} onBack={flow.backFromImport}
      actions={forward
        ? <SetupWizardStepAction forward disabled={pick.busy} onClick={flow.toBrowsers}>{text.next}</SetupWizardStepAction>
        : <>
          <SetupWizardStepAction disabled={pick.busy} onClick={flow.toBrowsers}>{text.skip}</SetupWizardStepAction>
          <SetupWizardStepAction variant="default" disabled={pick.busy || picked.length === 0}
            onClick={() => void pick.run(picked)}>
            {pick.busy ? text.importing : text.importAction}
          </SetupWizardStepAction>
        </>}
    >
      {pick.sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{text.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={text.agentsEmpty} /> : done ? null : (
        <ChoiceCardList aria-labelledby="first-run-agents-title" role="group">
          {pick.sources.map(source => {
            const on = picked.includes(source.key);
            return <ChoiceCard key={source.key} role="checkbox" aria-checked={on} selected={on} chevron={false}
              data-agent-import-source={source.key}
              icon={LOGOS[source.key] ? <ProviderLogo name={LOGOS[source.key]} /> : <Bot size="md" />}
              title={source.name} description={copy.found(source.instructions, source.servers)}
              state={!importable(source) ? "disabled" : pick.busy ? "disabled" : "default"}
              onClick={() => toggle(source.key)} />;
          })}
        </ChoiceCardList>
      )}
      {pick.result ? (
        <Notice tone="neutral" icon={<CheckCircle2 size="md" />}
          message={pick.undone ? copy.undone : copy.result(pick.result.instructions, pick.result.servers, pick.result.needs_secret)}
          action={pick.undone ? undefined : <ButtonContainer size="sm"><Button size="sm" variant="outline" disabled={pick.busy} onClick={() => void pick.undo()}>{copy.undo}</Button></ButtonContainer>} />
      ) : null}
      {pick.error ? <Typo.Caption role="alert" tone="danger">{copy.failed}</Typo.Caption> : null}
    </FirstRunStepCard>
  );
}
