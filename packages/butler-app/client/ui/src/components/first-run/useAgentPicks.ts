import { useState } from "react";
import type { AgentImportSource } from "../settings/agentImportApi";
import type { AgentImportSelection, useAgentImport } from "../imports/useAgentImport";

/** What a tool holds that can be imported: its instruction file label and its servers. */
export function agentItems(source: AgentImportSource) {
  return source.items ?? { instructions: [], servers: [] };
}

/** A tool is offered when it holds an instruction file or a server to import. */
export const importable = (source: AgentImportSource) => source.instructions || source.servers > 0;

type Choice = { instructions: boolean; servers: string[] };

/**
 * Import ① choices, kept across Back: which tools (page -1), then one page per chosen tool with its
 * items, all on at first. Nothing is imported until the last page's confirm.
 */
export function useAgentPicks(agentImport: ReturnType<typeof useAgentImport>) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [page, setPage] = useState(-1);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const sources = agentImport.sources ?? [];
  const chosen = picked ?? sources.filter(importable).map((source) => source.key);
  const tools = sources.filter((source) => chosen.includes(source.key));
  const choiceOf = (source: AgentImportSource): Choice => choices[source.key] ?? {
    instructions: agentItems(source).instructions.length > 0,
    servers: agentItems(source).servers.map((server) => server.name),
  };
  const update = (source: AgentImportSource, next: Choice) => setChoices((prior) => ({ ...prior, [source.key]: next }));
  const anything = (source: AgentImportSource) => {
    const choice = choiceOf(source);
    return (choice.instructions && agentItems(source).instructions.length > 0) || choice.servers.length > 0;
  };
  return {
    chosen, tools, page, current: page >= 0 ? tools[page] : undefined, choiceOf,
    toggleTool: (key: string) => setPicked(chosen.includes(key) ? chosen.filter((entry) => entry !== key) : [...chosen, key]),
    toggleInstructions: (source: AgentImportSource) => update(source, { ...choiceOf(source), instructions: !choiceOf(source).instructions }),
    toggleServer: (source: AgentImportSource, name: string) => {
      const choice = choiceOf(source);
      update(source, { ...choice, servers: choice.servers.includes(name) ? choice.servers.filter((entry) => entry !== name) : [...choice.servers, name] });
    },
    /** True when at least one item is on across the chosen tools. */
    anyOn: tools.some(anything),
    open: (index: number) => setPage(index),
    /** Imports each chosen tool in order with its items; tools with nothing on are skipped. */
    importAll: () => {
      const run = tools.filter(anything);
      const selections = Object.fromEntries(run.map((source): [string, AgentImportSelection] => {
        const choice = choiceOf(source);
        return [source.key, { instructions: choice.instructions && agentItems(source).instructions.length > 0, servers: choice.servers }];
      }));
      return agentImport.run(run.map((source) => source.key), selections);
    },
  };
}
