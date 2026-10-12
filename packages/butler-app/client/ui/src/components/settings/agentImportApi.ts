import { api } from "@/app/api.ts";

/** A detected AI tool: what it holds, never a path outside its label or a secret. */
export interface AgentImportSource {
  key: string;
  name: string;
  instructions: boolean;
  instructions_file: string | null;
  instructions_error?: string | null;
  servers: number;
  needs_secret: number;
  skipped: number;
  unreadable: boolean;
  /** Selectable items: the importable instruction file label, and every importable server. */
  items?: {
    instructions: string[];
    servers: { name: string; needs_secret: boolean }[];
  };
}

export interface AgentImportRequest {
  source: string;
  /** Omitted means import the instruction file. */
  instructions?: boolean;
  /** Omitted means all servers; an empty array means none. */
  servers?: string[];
}

export interface AgentImportCounts {
  run_id: string;
  instructions: number;
  instructions_existing: number;
  servers: number;
  servers_existing: number;
  needs_secret: number;
  skipped: number;
  instructions_error?: string | null;
  error?: string;
}

const action = <T>(op: string, body: unknown) =>
  api<T>(`/security/agent-import/${op}`, { method: "POST", body: JSON.stringify(body) });

export const listAgentImportSources = () => api<{ sources: AgentImportSource[] }>("/security/agent-import/sources");
export const startAgentImport = (source: string, selection?: Omit<AgentImportRequest, "source">) =>
  action<AgentImportCounts>("start", { ...selection, source });
export const undoAgentImport = (run_id: string) => action<{ instructions: number; servers: number }>("undo", { run_id });
