import { browserRandomUUID } from "@/app/id.ts";
import type {
  McpSecretInput,
  McpServerUpsertRequest,
  McpServerView,
  McpTransportKind,
} from "@/app/types.ts";

export interface McpServerFormState {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpTransportKind;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  envRows: McpSecretRowState[];
  headerRows: McpSecretRowState[];
  envDirty: boolean;
  headersDirty: boolean;
}

export interface McpSecretRowState {
  id: string;
  key: string;
  source: McpSecretInput["source"];
  value: string;
  redacted?: boolean;
}

export function emptyMcpServerForm(): McpServerFormState {
  return {
    id: "",
    displayName: "",
    enabled: true,
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    envRows: [],
    headerRows: [],
    envDirty: false,
    headersDirty: false,
  };
}

export function formFromMcpServer(server: McpServerView): McpServerFormState {
  return {
    id: server.id,
    displayName: server.display_name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command ?? "",
    argsText: server.args.join("\n"),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    envRows: server.env.map(secretRowFromView),
    headerRows: server.headers.map(secretRowFromView),
    envDirty: false,
    headersDirty: false,
  };
}

export function mcpServerPayload(
  form: McpServerFormState,
  includeSecrets: { env: boolean; headers: boolean },
): McpServerUpsertRequest {
  return {
    id: form.id,
    display_name: form.displayName,
    enabled: form.enabled,
    transport: form.transport,
    command: form.command,
    args: lineList(form.argsText),
    cwd: form.cwd,
    url: form.url,
    ...(includeSecrets.env ? { env: secretList(form.envRows) } : {}),
    ...(includeSecrets.headers ? { headers: secretList(form.headerRows) } : {}),
  };
}

export function mcpServerSubtitle(server: McpServerView): string {
  const target = server.transport === "stdio"
    ? [server.command, ...server.args].filter(Boolean).join(" ")
    : server.url;
  const capabilities = [
    server.env.length ? `env ${server.env.length}` : "",
    server.headers.length ? `headers ${server.headers.length}` : "",
  ].filter(Boolean).join(" · ");
  return [server.transport, target, capabilities].filter(Boolean).join(" · ");
}

export function lineList(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function secretList(rows: McpSecretRowState[]): McpSecretInput[] {
  return rows.flatMap((row) => {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key || (!value && !row.redacted)) return [];
    return [{
      key,
      source: row.source,
      value,
    }];
  });
}

export function emptySecretRow(source: McpSecretInput["source"] = "literal"): McpSecretRowState {
  return {
    id: browserRandomUUID(),
    key: "",
    source,
    value: "",
  };
}

function secretRowFromView(secret: McpServerView["env"][number]): McpSecretRowState {
  return {
    id: browserRandomUUID(),
    key: secret.key,
    source: secret.source,
    value: secret.value ?? "",
    redacted: secret.redacted,
  };
}
