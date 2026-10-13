import { type ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Bot, Button, ButtonContainer, EmptyLine, ListRow, SettingsSection, Spinner, Stack, Typo } from "@/butler-ds";
import type { AgentImportCounts, AgentImportSource } from "./agentImportApi";
import { useAgentImport } from "../imports/useAgentImport";

type AgentImportFlow = ReturnType<typeof useAgentImport>;

/** One detected tool: name, what it holds and its own import action. */
function AgentRow({ source, flow }: { source: AgentImportSource; flow: AgentImportFlow }) {
  const copy = appCopy.settings.agentImport;
  const empty = !source.instructions && source.servers === 0;
  return (
    <Stack align="row" cross="center" gap="sm" data-agent-import-source={source.key}>
      <Stack grow minWidth="0"><ListRow icon={<Bot size="md" />} title={source.name} description={copy.found(source.instructions, source.servers)} /></Stack>
      <Button size="sm" variant="outline" disabled={flow.busy || empty} aria-label={`${copy.run} · ${source.name}`}
        onClick={() => void flow.run(source.key)}>{copy.run}</Button>
    </Stack>
  );
}

function resultText(result: AgentImportCounts): string {
  const copy = appCopy.settings.agentImport;
  return result.instructions + result.servers === 0
    ? copy.nothingNew
    : copy.result(result.instructions, result.servers, result.needs_secret);
}

/**
 * Other AI tools first, then browsers (Settings; first run uses its own import substeps).
 * Settings adds the memory import as one more row after the detected tools.
 */
export function AgentImportSection({ children }: { children?: ReactNode }) {
  const copy = appCopy.settings.agentImport;
  const flow = useAgentImport();
  const imported = flow.sources?.find(source => source.key === flow.selected);
  return (
    <SettingsSection id="agent-import" kind="list" title={appCopy.settings.pageSections.agentImport}
      description={copy.purpose} state={flow.sources === null ? "loading" : "ready"}>
      {!flow.result ? (flow.sources?.length
        ? flow.sources.map(source => <AgentRow key={source.key} source={source} flow={flow} />)
        : <EmptyLine message={copy.noSources} />) : null}
      {children}
      {flow.busy ? <Stack align="row" gap="sm" cross="center" role="status"><Spinner /><Typo.Text>{copy.importing}</Typo.Text></Stack> : null}
      {flow.result ? <Stack gap="sm" role="status" data-test-class="agent-import-result">
        {/* What was added and any key still to enter; change imported items in their own settings. */}
        <ListRow icon={<Bot size="md" />} title={imported?.name ?? copy.run} description={resultText(flow.result)} />
        <ButtonContainer size="sm">
          <Button size="sm" variant="ghost" disabled={flow.busy} onClick={flow.more}>{copy.more}</Button>
        </ButtonContainer>
      </Stack> : null}
      {flow.error ? <Stack gap="sm" role="alert">
        <Typo.Caption>{copy.failed}</Typo.Caption>
        {flow.selected && !flow.result ? <ButtonContainer size="sm">
          <Button size="sm" variant="outline" disabled={flow.busy} onClick={() => void flow.run(flow.selected!)}>{copy.retry}</Button>
        </ButtonContainer> : null}
      </Stack> : null}
    </SettingsSection>
  );
}
