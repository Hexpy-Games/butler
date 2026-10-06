import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { NativeAppServerHandle } from "./native-app-server.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort((a, b) => a.localeCompare(b, "en")).map(key => [key, item[key]]));
});

/** Seeds existing storage, including real scope identity; no new grant/enforcement format. */
export async function seedApprovalFixture(server: NativeAppServerHandle) {
  const sessions: string[] = [];
  for (const title of ["Settings review", "Settings review", "Files review"]) {
    const result = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) });
    sessions.push(result.session.id);
  }
  const db = new Database(join(server.butlerData, "agent-runtime/btcc.sqlite"));
  const command = "bun run check --filter settings-review --exact-target-with-a-long-name";
  const workspace = "/workspace/butler";
  const refs: { session_id: string; grant_ref: string }[] = [];
  db.transaction(() => {
    for (let i = 0; i < 12; i++) {
      const owner = `butler/app-${sessions[i % 3]}`;
      const capability = i === 2 ? "write_file" : i === 3 ? "call_mcp_tool" : i === 4 ? "web_fetch" : "run_command";
      const target = i < 2 ? command : i === 2 ? "src/one.ts\nsrc/two.ts" : i === 3 ? "linear.create_issue" : i === 4 ? "https://example.test/api" : `cargo test case_${i}`;
      const input = capability === "run_command" ? { command: target, cwd: workspace } : capability === "write_file" ? { requests: [{ path: "src/one.ts" }, { path: "src/two.ts" }] } : { target };
      const scope = capability === "run_command" ? { kind: "command", command: target, cwd: workspace } : { kind: capability === "write_file" ? "file_operation" : "effect", capability, target, input };
      const scopeKey = digest(canonical(scope));
      const reference = `permission-${digest(canonical([owner, workspace, scopeKey])).slice(0, 32)}`;
      const id = `fixture-${i}`;
      const date = `2026-10-05T00:00:${String(59 - i).padStart(2, "0")}Z`;
      const source = {
        request_id: id, request_ref: id, identity_sha256: id, owner_session_id: owner, source_session_id: owner,
        source_turn_id: id, source_work_id: id, workspace_path: workspace, plan_revision_id: id, action_key: id,
        authority_generation: 1, capability, normalized_target: target, normalized_input_json: JSON.stringify(input),
        model_ref: "custom/stub", reasoning_effort: "low", category: capability === "run_command" ? "command" : "reviewed_effect",
        reason: "Apply one reviewed effect", executable: capability, command_count: 1, decision: "allowed", allow_scope: "conversation",
        schedule_client_message_id: id, schedule_input_text: "", outcome: "applied", created_at: date, updated_at: date,
      };
      db.prepare(`INSERT INTO btcc_authority_requests (${Object.keys(source).join(",")}) VALUES (${Object.keys(source).map(() => "?").join(",")})`).run(...Object.values(source));
      db.prepare("INSERT INTO btcc_conversation_permissions VALUES(?,?,?,?,?,?,?,NULL)").run(reference, owner, workspace, scopeKey, "Private title", "Private description", date);
      refs.push({ session_id: owner, grant_ref: reference });
    }
    // A deleted source/conversation must remain manageable with an unknown target.
    db.prepare("INSERT INTO btcc_conversation_permissions VALUES('missing-source','deleted-chat',?,'missing','Private','Private','2026-09-01T00:00:00Z',NULL)").run(workspace);
  })();
  db.close();
  const app = new Database(join(server.butlerData, "app-server/butler-client.sqlite"));
  app.exec("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599) INSERT INTO chats(id,title,kind,created_at,updated_at) SELECT 'scale-'||i,'Historical chat '||i,'chat','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z' FROM n");
  app.close();
  return { command, refs, sessions };
}
