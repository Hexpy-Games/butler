export type GrantScope = "conversation" | "project" | "always";
export type GrantKind = "command" | "fileWrite" | "network" | "tool" | "other";
export interface GrantRef { grant_ref: string; session_id: string }
export interface GrantRecord extends GrantRef {
  capability: string; target: string; cwd: string | null; scope: GrantScope;
  session_title: string | null; project_id: string | null; project_name: string | null;
  workspace_path: string; created_at: string;
}
export interface GrantedRow {
  key: string; kind: GrantKind; target: string; cwd: string | null; scope: GrantScope;
  places: Map<string, string | null>; project: string | null; createdAt: string; refs: GrantRef[];
}

export function grantKind(capability: string): GrantKind {
  if (capability === "run_command" || capability === "run_command_remote_observation") return "command";
  if (capability === "write_file" || capability === "edit_file") return "fileWrite";
  if (/^(web_|fetch_|http_)/u.test(capability)) return "network";
  if (capability === "call_mcp_tool") return "tool";
  return "other";
}

/** Group by the approved public identity, retaining every storage reference and conversation. */
export function groupGrants(records: readonly GrantRecord[]): GrantedRow[] {
  const rows = new Map<string, GrantedRow>();
  for (const record of records) {
    const kind = grantKind(record.capability);
    const key = JSON.stringify([kind, record.target, record.cwd, record.scope, record.project_id]);
    const row: GrantedRow = rows.get(key) ?? {
      key, kind, target: record.target, cwd: record.cwd, scope: record.scope,
      places: new Map(), project: record.project_name, createdAt: record.created_at, refs: [],
    };
    row.places.set(record.session_id, record.session_title);
    if (record.created_at > row.createdAt) row.createdAt = record.created_at;
    row.refs.push({ grant_ref: record.grant_ref, session_id: record.session_id });
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
