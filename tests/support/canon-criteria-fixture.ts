// test-category: pure-logic
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { EpicDetail, PlanDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const criteriaText = "변경 내용을 기준별로 확인할 수 있다";
export const criteria = (text = criteriaText) => [
  { id: "VB-03", part_id: "확인", text },
  { id: "VB-04", part_id: "확인", text: "확인한 사람과 시점을 기록한다" },
];
export async function seedCriteria(server: NativeAppServerHandle) {
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profile: { principal_name: "하늘" } }) });
  const { project } = await server.api<{ project: { id: string } }>("/projects", post({ source: "scratch", display_name: "캐논 보드" }));
  const plan = await server.api<PlanDetail>(`/projects/${project.id}/canon/plans`, post({ title: "검토 기준 정리" }));
  const epic = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, post({ title: "변경 내용 확인", description: "기준을 하나씩 살펴보고 확인을 남깁니다.", plan_id: plan.id, assignee: "app-user" }));
  const empty = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, post({ title: "다음 검토 준비", description: "검토할 내용을 모읍니다.", plan_id: plan.id }));
  const { session_id } = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, post({}));
  const node = "review-spec";
  const body = `# 확인\n${criteria().map(c => `- ${c.id} ${c.text}`).join("\n")}`;
  const hash = createHash("sha256").update(body).digest("hex");
  const db = new Database(join(server.butlerData, "agent-runtime/btcc.sqlite"));
  try {
    db.transaction(() => {
      db.run("INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,concern_id,visibility,lifecycle,source,revision,created_at,updated_at,created_by) VALUES(?,'project',?,?,'검토 기준','canon','active','local',2,1,1,'{}')", [node, project.id, epic.id]);
      db.run("INSERT INTO canon_spec_bodies VALUES(?,?,?)", [hash, Bun.zstdCompressSync(body), Buffer.byteLength(body)]);
      db.run("INSERT INTO canon_spec_revisions VALUES(?,1,?,'markdown','active')", [node, hash]);
      for (const c of criteria()) db.run("INSERT INTO canon_spec_criteria VALUES(?,1,?,?,?)", [node, c.id, c.part_id, c.text]);
      db.run("UPDATE canon_spec_nodes SET active_revision=1 WHERE node_id=?", [node]);
      db.run("UPDATE canon_epics SET spec_node_id=? WHERE id=?", [node, epic.id]);
    })();
  } finally { db.close(); }
  return { project: project.id, plan: plan.id, epic: epic.id, empty: empty.id, session: session_id, node };
}
export type CriteriaFixture = Awaited<ReturnType<typeof seedCriteria>>;
export async function publishCriteria(server: NativeAppServerHandle, fixture: CriteriaFixture, text = criteriaText) {
  const epic = await server.api<EpicDetail>(`/canon/epics/${fixture.epic}`);
  const items = criteria(text);
  const result = await server.api<{ ok: boolean; error?: unknown }>(`/sessions/${fixture.session}/canon/propose`, post({
    turn_id: "review-turn", call_id: crypto.randomUUID(), apply: true,
    arguments: { project_id: fixture.project, summary: "검토 기준 보강", changes: [
      { op: "spec.edit", id: fixture.node, expected_revision: epic.specs[0]!.revision,
        body: `# 검토 기준\n${items.map(c => `- ${c.id} ${c.text}`).join("\n")}`, criteria: items },
    ] },
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
}
