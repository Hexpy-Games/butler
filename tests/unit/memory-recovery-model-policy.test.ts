import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNextProjectionWindow, configureProjectionModelPolicy, ensureV2MemorySchema, fallbackProjectionWindowOnQuota, readProjectionModelPolicy, recordProviderInvocationIntent } from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import { runPromptTextWithUsage } from "../../packages/butler-agent/src/integrations/providers/runtime.ts";
import { registerHostedModelConfig } from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";

const policy = { primary_model: "zai/glm-5.3", primary_effort: "high", fallback_model: "openai/gpt-5.6-sol", fallback_effort: "medium" };
function seed(path: string): Database {
  const db = new Database(path);
  ensureV2MemorySchema(db);
  db.query(`INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
    VALUES('job','episode','r1','v2','generation','openai/gpt-5.6-sol','medium','[]','{}','{}','{}','{}','{}','2026-09-11')`).run();
  for (const [ref, state, ordinal] of [["done", "complete", 0], ["next", "pending", 1]] as const) {
    db.query("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state,input_json,input_sha256) VALUES(?,'job',?,'[]',?,'{\"frozen\":true}','hash')").run(ref, ordinal, state);
  }
  return db;
}

test("ZAI text request uses JSON mode and full schema through the real provider adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-zai-contract-"));
  const previousData = process.env.BUTLER_DATA;
  const previousFetch = globalThis.fetch;
  try {
    process.env.BUTLER_DATA = dir;
    registerHostedModelConfig({ providerId: "zai", modelId: "glm-5.3", authType: "api_key", apiKey: "test-only" }, dir);
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({model:"glm-5.3",choices:[{message:{role:"assistant",content:'{"ok":true}'},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}), {headers:{"Content-Type":"application/json"}});
    }) as typeof fetch;
    const schema = {type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false};
    const result = await runPromptTextWithUsage({butlerData:dir,model:policy.primary_model,reasoningEffort:"high",instructions:"Extract without changing facts.",prompt:"fixed input",providerRetryAttempts:0,responseFormat:{type:"json_schema",name:"test",strict:true,schema}});
    expect(result.text).toBe('{"ok":true}');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({model:"glm-5.3",reasoning_effort:"high",response_format:{type:"json_object"},stream:true});
    expect(bodies[0].messages[0].content).toBe(`Extract without changing facts.\n\nReturn exactly one JSON object matching the following JSON Schema. Do not wrap it in Markdown or add explanatory text.\n${JSON.stringify(schema)}`);
    expect(bodies[0].messages[1].content).toBe("fixed input");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousData === undefined) delete process.env.BUTLER_DATA; else process.env.BUTLER_DATA = previousData;
    rmSync(dir,{recursive:true,force:true});
  }
});

for (const limit of [{statusCode:429,providerCode:"provider_rate_limited"},{statusCode:402,providerCode:"provider_quota_exhausted"}]) {
  test(`quota ${limit.providerCode} settles failed GLM and persists Sol without changing completed data`, () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-model-policy-")); const path = join(dir,"graph.sqlite");let db=seed(path);
    try {
      const completed=db.query("SELECT * FROM memory_projection_windows WHERE window_ref='done'").get();
      const originalJob=db.query("SELECT extraction_model,reasoning_effort FROM memory_projection_jobs").get();
      configureProjectionModelPolicy(db,policy);
      const pending=claimNextProjectionWindow(db)!;
      expect([pending.model,pending.reasoningEffort]).toEqual([policy.primary_model,"high"]);
      expect(()=>configureProjectionModelPolicy(db,policy)).toThrow("memory_projection_model_change_busy");
      recordProviderInvocationIntent(db,pending.window_ref,pending.ownerNonce);
      const request={jobId:pending.job_id,windowRef:pending.window_ref,ownerNonce:pending.ownerNonce,model:pending.model,...limit,failureEvidence:{configured_model:pending.model,upstream_status:limit.statusCode}};
      // A commit fault must roll back both failure settlement and policy switch.
      db.exec("CREATE TRIGGER reject_policy BEFORE UPDATE ON memory_projection_model_policy BEGIN SELECT RAISE(ABORT,'blocked'); END");
      expect(()=>fallbackProjectionWindowOnQuota(db,request)).toThrow("blocked");
      expect(db.query<any,[]>("SELECT state FROM memory_projection_windows WHERE window_ref='next'").get().state).toBe("running");
      expect(db.query<any,[]>("SELECT count(*) n FROM memory_projection_attempts WHERE state='failed'").get().n).toBe(0);
      db.exec("DROP TRIGGER reject_policy");
      expect(fallbackProjectionWindowOnQuota(db,request)).toBe(true);
      const failed=db.query<any,[]>("SELECT * FROM memory_projection_attempts WHERE state='failed'").get();
      expect(failed.provider_invoked).toBe(1);expect(failed.outcome_known).toBe(1);
      expect(JSON.parse(failed.provider_evidence_json).configured_model).toBe(policy.primary_model);
      db.close();db=new Database(path);
      expect(readProjectionModelPolicy(db)?.active_slot).toBe("fallback");
      const next=claimNextProjectionWindow(db)!;
      expect([next.model,next.reasoningEffort]).toEqual([policy.fallback_model,"medium"]);
      expect(next.pinnedInput).toEqual({frozen:true});expect(next.recoveryAttemptCount).toBe(0);
      expect(fallbackProjectionWindowOnQuota(db,{...request,ownerNonce:next.ownerNonce,model:next.model})).toBe(false);
      expect(db.query("SELECT * FROM memory_projection_windows WHERE window_ref='done'").get()).toEqual(completed);
      expect(db.query("SELECT extraction_model,reasoning_effort FROM memory_projection_jobs").get()).toEqual(originalJob);
      expect(db.query("SELECT * FROM memory_projection_attempts WHERE state='failed'").get()).toEqual(failed);
    } finally {db.close();rmSync(dir,{recursive:true,force:true});}
  });
}

test("authentication, timeout, generic failure and schema errors do not select quota fallback", () => {
  const db=seed(":memory:");
  try {
    configureProjectionModelPolicy(db,policy);const pending=claimNextProjectionWindow(db)!;
    for(const failure of [{statusCode:401,providerCode:"provider_auth_failed"},{statusCode:500},{providerCode:"provider_round_timeout"},{providerCode:"memory_extract_invalid_ref"}])
      expect(fallbackProjectionWindowOnQuota(db,{jobId:pending.job_id,windowRef:pending.window_ref,ownerNonce:pending.ownerNonce,model:pending.model,...failure})).toBe(false);
    expect(readProjectionModelPolicy(db)?.active_slot).toBe("primary");
    expect(db.query<any,[]>("SELECT state FROM memory_projection_windows WHERE window_ref='next'").get().state).toBe("running");
  } finally {db.close();}
});
