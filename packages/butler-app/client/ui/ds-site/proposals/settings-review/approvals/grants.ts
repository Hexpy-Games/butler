// Grant rows as the agent returns them today (GET /authority-requests?session_id=… → permissions[]:
// grant_ref, capability, target, cwd, title, description), plus the fields this list also needs,
// marked PROPOSED (not in the API): session_id/session_title (a cross-conversation list),
// created_at (stored in btcc_conversation_permissions but not returned), scope beyond
// "conversation" (storage has only "once" | "conversation"), project_name.

export type GrantScope = "conversation" | "project" | "always";
export type GrantKind = "command" | "fileWrite" | "network" | "tool" | "other";

export interface GrantRecord {
  grant_ref: string;
  capability: string;
  target: string;
  cwd: string | null;
  /** PROPOSED */ session_title: string;
  /** PROPOSED */ created_at: string;
  /** PROPOSED (today always "conversation") */ scope: GrantScope;
  /** PROPOSED */ project_name?: string;
}

export interface GrantRow {
  key: string;
  kind: GrantKind;
  target: string;
  cwd: string | null;
  scope: GrantScope;
  /** Where it applies: one conversation title, a count, or the project name. */
  places: string[];
  project?: string;
  /** Latest grant date of the group. */
  createdAt: string;
  refs: string[];
}

/** Capability ids → friendly kinds (capability ids never reach the UI). */
export function grantKind(capability: string): GrantKind {
  if (capability === "run_command" || capability === "run_command_remote_observation") return "command";
  if (capability === "write_file" || capability === "edit_file") return "fileWrite";
  if (/^(web_|fetch_|http_)/u.test(capability)) return "network";
  if (capability === "call_mcp_tool") return "tool";
  return "other";
}

/** Identical grants (same kind, target, cwd and scope) collapse into one row, newest date first. */
export function groupGrants(records: readonly GrantRecord[]): GrantRow[] {
  const rows = new Map<string, GrantRow>();
  for (const record of records) {
    const kind = grantKind(record.capability);
    const key = JSON.stringify([kind, record.target, record.cwd, record.scope, record.project_name ?? ""]);
    const row = rows.get(key) ?? {
      key, kind, target: record.target, cwd: record.cwd, scope: record.scope, places: [],
      project: record.project_name, createdAt: record.created_at, refs: [],
    };
    if (!row.places.includes(record.session_title)) row.places.push(record.session_title);
    if (record.created_at > row.createdAt) row.createdAt = record.created_at;
    row.refs.push(record.grant_ref);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const BASE: GrantRecord[] = [
  { grant_ref: "permission-a1", capability: "run_command", target: "bun run test:unit --filter settings", cwd: "~/butler", session_title: "설정 오류 정리", created_at: "2026-10-04T09:12:00Z", scope: "conversation" },
  { grant_ref: "permission-a2", capability: "run_command", target: "bun run test:unit --filter settings", cwd: "~/butler", session_title: "업데이트 진행률", created_at: "2026-10-03T16:40:00Z", scope: "conversation" },
  { grant_ref: "permission-b1", capability: "write_file", target: "packages/butler-app/client/ui/src/components/settings/UpdateComponentRow.tsx", cwd: null, session_title: "업데이트 진행률", created_at: "2026-10-03T16:02:00Z", scope: "conversation" },
  { grant_ref: "permission-c1", capability: "run_command", target: "git push origin design/settings-review --force-with-lease", cwd: "~/butler", session_title: "", created_at: "2026-10-02T11:20:00Z", scope: "project", project_name: "butler" },
  { grant_ref: "permission-d1", capability: "web_fetch", target: "https://api.github.com/repos/Hexpy-Games/butler/issues?state=open&labels=design-review", cwd: null, session_title: "", created_at: "2026-09-30T08:05:00Z", scope: "always" },
  { grant_ref: "permission-e1", capability: "call_mcp_tool", target: "linear.create_issue", cwd: null, session_title: "주간 정리", created_at: "2026-09-29T19:30:00Z", scope: "conversation" },
];

const EXTRA: GrantRecord[] = Array.from({ length: 14 }, (_, index) => ({
  grant_ref: `permission-x${index}`,
  capability: index % 3 === 0 ? "edit_file" : "run_command",
  target: index % 3 === 0 ? `docs/notes/week-${40 - index}.md` : `cargo test -p butler-gateway settings::case_${index}`,
  cwd: index % 3 === 0 ? null : "~/butler/packages/butler-agent/rust",
  session_title: index % 2 ? "Rust 설정 검증" : "문서 정리",
  created_at: `2026-09-${String(28 - index).padStart(2, "0")}T10:00:00Z`,
  scope: "conversation" as const,
}));

export function grantFixture(long: boolean): GrantRecord[] {
  return long ? [...BASE, ...EXTRA] : BASE;
}
