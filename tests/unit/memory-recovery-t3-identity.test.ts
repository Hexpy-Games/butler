import { expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";

mock.module("../../packages/butler-agent/src/integrations/providers/runtime.ts", () => ({
  runPromptTextWithUsage: async (request: { prompt: string; model: string }) => {
    const input = JSON.parse(request.prompt) as { window_ref: string; source_units: Array<{ ref: string; text: string }> };
    const source = input.source_units[0]!;
    const label = source.text.includes("Luna only") ? "Luna" : source.text.includes("루나 only") ? "루나" : source.text.includes("Selene only") ? "Selene" : null;
    const evidence = label ? [{ unit_ref: source.ref, quote: label, occurrence: 0 }] : [];
    const outOfScopeCandidate = source.text.includes("reuse out of scope")
      ? (input as any).candidates?.find((candidate: any) => candidate.type === "entity" && candidate.aliases.includes("루나"))
      : null;
    const resolution = outOfScopeCandidate
      ? { kind: "reuse", node_ref: outOfScopeCandidate.ref, reason: "explicit_alias", evidence: [
        { unit_ref: source.ref, quote: label, occurrence: 0 },
        { unit_ref: outOfScopeCandidate.evidence[0].ref, quote: outOfScopeCandidate.evidence[0].text, occurrence: 0 },
      ] }
      : { kind: "create", provisional: false, identity_scope: "user" };
    return {
      text: JSON.stringify({
        schema: "butler.memory-extract-output.v2",
        window_ref: input.window_ref,
        disposition: "processed",
        covered_unit_refs: input.source_units.map((unit) => unit.ref),
        nodes: label ? [{ local_ref: "cat", type: "entity", label, resolution, aliases: [], evidence }] : [],
        claims: label ? [{ local_ref: "identity-fact", type: "memory_atom", resolution: { kind: "create", provisional: false, identity_scope: "user" },
          statement: source.text, subject_ref: "cat", object_ref: "cat", speech_act: "assertion", basis: "user_statement",
          polarity: "positive", condition: null, valid_from: null, valid_to: null, salience: "normal", evidence }] : [],
        relations: [],
        corrections: [], summary: label ? { text: source.text, evidence } : null,
      }),
      model: request.model,
      usage: { promptTokens: 10, cachedTokens: 0, outputTokens: 10, totalTokens: 20 },
    };
  },
  runPromptText: async () => { throw new Error("unexpected provider call"); },
  runFunctionToolPromptText: async () => { throw new Error("unexpected provider call"); },
  runModelRound: async () => { throw new Error("unexpected provider call"); },
  createProviderModelRoundPort: () => { throw new Error("unexpected provider port"); },
}));

test("T3 identity CLI preserves scoped source-backed graph history across transitive apply and revoke", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-t3-identity-"));
  try {
    const descriptor = initializeEmptyMemoryGeneration(butlerData);
    const memory = await import("../../packages/butler-agent/src/agent/cognition/memory/index.ts");
    const identity = await import("../../packages/butler-agent/src/agent/cognition/memory/projection/identity.ts");
    const context = { butlerData, target: { kind: "active" as const, expected_generation: descriptor.generation_id }, signal: new AbortController().signal };
    const luna = seedTurn(butlerData, "turn-luna", "Luna only is my cat.", "2026-09-08T00:00:00.000Z");
    const korean = seedTurn(butlerData, "turn-korean", "루나 only is my cat.", "2026-09-08T00:01:00.000Z");
    const selene = seedTurn(butlerData, "turn-selene", "Selene only is my cat.", "2026-09-08T00:02:00.000Z");
    const decision = seedTurn(butlerData, "turn-decision", "Luna와 루나는 같은 고양이야.", "2026-09-08T00:03:00.000Z");
    const decision2 = seedTurn(butlerData, "turn-decision-2", "Luna와 Selene은 같은 고양이야.", "2026-09-08T00:04:00.000Z");
    const foreign = seedTurn(butlerData, "turn-foreign", "Luna only is my cat.", "2026-09-08T00:05:00.000Z", "other-project", "foreign-session");
    const projectDecision = seedTurn(butlerData, "turn-project-decision", "루나와 Luna는 같은 고양이야.", "2026-09-08T00:06:00.000Z", "project-a", "project-session");
    const jobs = [];
    for (const source of [luna, korean, selene, decision, decision2, foreign, projectDecision]) jobs.push(await memory.ingestConversationMemory({ context, source }));
    for (let count = 0; count < 32; count += 1) {
      const progress = await memory.advanceNextMemoryProjection({ context });
      if ([...jobs.slice(0, 3), jobs[5]!, jobs[6]!].every((job) => memoryState(butlerData, descriptor.generation_id, job.job_id) === "complete")) break;
      expect(progress).not.toBeNull();
    }

    const graphPath = join(butlerData, "cognition", "memory", "generations", descriptor.generation_id, "graph.sqlite");
    const db = new Database(graphPath, { readonly: true });
    const sources = db.query<{ source_id: string; conversation_turn_id: string }, []>(`SELECT s.source_id,c.conversation_turn_id FROM memory_chunk_sources s
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE s.role='user' ORDER BY c.conversation_turn_id`).all();
    const sourceByTurn = new Map(sources.map((source) => [source.conversation_turn_id, source.source_id]));
    const nodeForSource = (sourceId: string) => db.query<{ entity_id: string }, [string]>("SELECT m.entity_id FROM entity_mentions m JOIN entities e ON e.id=m.entity_id WHERE m.source_id=? AND e.type='entity' ORDER BY m.entity_id LIMIT 1").get(sourceId)!.entity_id;
    const decisionSource = sourceByTurn.get("turn-decision")!, decisionSource2 = sourceByTurn.get("turn-decision-2")!;
    const projectDecisionSource = sourceByTurn.get("turn-project-decision")!;
    const loserSource = sourceByTurn.get("turn-korean")!, canonicalSource = sourceByTurn.get("turn-luna")!, finalCanonicalSource = sourceByTurn.get("turn-selene")!;
    const foreignSource = sourceByTurn.get("turn-foreign")!;
    const loser = nodeForSource(loserSource), canonical = nodeForSource(canonicalSource), finalCanonical = nodeForSource(finalCanonicalSource), foreignCanonical = nodeForSource(foreignSource);
    let typedEdgesBefore = db.query<{ edge_id: string; source_node_id: string; target_node_id: string; claim_node_id: string; chunk_source_id: string }, []>(`
      SELECT e.edge_id,e.source_node_id,e.target_node_id,e.claim_node_id,ee.chunk_source_id FROM edges e
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id ORDER BY e.edge_id,ee.chunk_source_id
    `).all();
    db.close();
    expect([loser, canonical, finalCanonical, foreignCanonical, decisionSource, decisionSource2, projectDecisionSource, loserSource, canonicalSource, finalCanonicalSource, foreignSource].every(Boolean)).toBe(true);
    expect(typedEdgesBefore.length).toBeGreaterThanOrEqual(4);

    const inspect = runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource, node_refs: [loser, canonical],
    });
    expect(inspect.status).toBe(0);
    const states = JSON.parse(inspect.stdout).states;
    const command = {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "apply",
      operation_id: "apply-normal-1", decision: "same_entity", reason: "explicit_alias",
      source: { source_ref: decisionSource, quote: "같은 고양이", occurrence: 0 },
      loser_node_ref: loser, canonical_node_ref: canonical,
      loser_evidence: { source_ref: loserSource, quote: "루나", occurrence: 0 },
      canonical_evidence: { source_ref: canonicalSource, quote: "Luna", occurrence: 0 },
      expected_loser: states[loser], expected_canonical: states[canonical],
    };
    const missingOperationId = structuredClone(command) as Record<string, unknown>;
    delete missingOperationId.operation_id;
    expect(runIdentityCli(butlerData, "apply", missingOperationId).status).not.toBe(0);
    expect(runIdentityCli(butlerData, "apply", {
      ...command,
      operation_id: "apply-wrong-grounding",
      canonical_evidence: { source_ref: decisionSource, quote: "같은 고양이", occurrence: 0 },
    }).status).not.toBe(0);
    const projectStates = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: projectDecisionSource, node_refs: [loser, canonical],
    }).stdout).states;
    const projectApplied = JSON.parse(runIdentityCli(butlerData, "apply", {
      ...command, operation_id: "apply-project-only", source: { source_ref: projectDecisionSource, quote: "같은 고양이", occurrence: 0 },
      expected_loser: projectStates[loser], expected_canonical: projectStates[canonical],
    }).stdout);
    const outOfScopeSource = seedTurn(butlerData, "turn-out-of-scope-reuse", "루나 only reuse out of scope.", "2026-09-08T00:07:00.000Z");
    const outOfScopeJob = await memory.ingestConversationMemory({ context, source: outOfScopeSource });
    for (let count = 0; count < 8 && memoryState(butlerData, descriptor.generation_id, outOfScopeJob.job_id) !== "complete"; count += 1)
      expect(await memory.advanceNextMemoryProjection({ context })).not.toBeNull();
    const scopeCheck = new Database(graphPath, { readonly: true });
    const outOfScopeSourceRef = scopeCheck.query<{ source_id: string }, []>(`SELECT s.source_id FROM memory_chunk_sources s
      JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE c.conversation_turn_id='turn-out-of-scope-reuse' AND s.role='user'`).get()!.source_id;
    expect(scopeCheck.query<{ entity_id: string }, [string]>(`SELECT m.entity_id FROM entity_mentions m JOIN entities e ON e.id=m.entity_id
      WHERE m.source_id=? AND e.type='entity' ORDER BY m.entity_id LIMIT 1`).get(outOfScopeSourceRef)?.entity_id).toBe(loser);
    expect(scopeCheck.query<{ n: number }, [string, string]>(`SELECT COUNT(*) n FROM edges e JOIN edge_evidence ee ON ee.edge_id=e.edge_id
      WHERE ee.chunk_source_id=? AND e.rel_type IN ('has_subject','has_object') AND e.target_node_id=?`).get(outOfScopeSourceRef, loser)?.n).toBe(2);
    scopeCheck.close();
    const projectRevoke = runIdentityCli(butlerData, "revoke", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "revoke",
      operation_id: "revoke-project-only", source: { source_ref: projectDecisionSource, quote: "같은 고양이", occurrence: 0 },
      decision_job_ref: projectApplied.source_job_ref, decision_ref: projectApplied.decision_ref,
      expected_loser: { direct_redirect: canonical, resolved_node_ref: canonical, history_head: { job_ref: projectApplied.source_job_ref, decision_ref: projectApplied.decision_ref } },
    });
    expect(projectRevoke.status).toBe(0);
    const graphAfterScopeProof = new Database(graphPath, { readonly: true });
    typedEdgesBefore = graphAfterScopeProof.query<{ edge_id: string; source_node_id: string; target_node_id: string; claim_node_id: string; chunk_source_id: string }, []>(`
      SELECT e.edge_id,e.source_node_id,e.target_node_id,e.claim_node_id,ee.chunk_source_id FROM edges e
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id ORDER BY e.edge_id,ee.chunk_source_id
    `).all();
    graphAfterScopeProof.close();
    const foreignStates = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource, node_refs: [loser, foreignCanonical],
    }).stdout).states;
    expect(runIdentityCli(butlerData, "apply", {
      ...command, operation_id: "apply-incompatible-grounding-scope", canonical_node_ref: foreignCanonical,
      canonical_evidence: { source_ref: foreignSource, quote: "Luna", occurrence: 0 },
      expected_loser: foreignStates[loser], expected_canonical: foreignStates[foreignCanonical],
    }).status).not.toBe(0);
    const preChainStates = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource2, node_refs: [canonical, finalCanonical],
    }).stdout).states;
    const preChainCommand = {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "apply",
      operation_id: "apply-b-c-before-a-b", decision: "same_entity", reason: "explicit_alias",
      source: { source_ref: decisionSource2, quote: "같은 고양이", occurrence: 0 },
      loser_node_ref: canonical, canonical_node_ref: finalCanonical,
      loser_evidence: { source_ref: canonicalSource, quote: "Luna", occurrence: 0 },
      canonical_evidence: { source_ref: finalCanonicalSource, quote: "Selene", occurrence: 0 },
      expected_loser: preChainStates[canonical], expected_canonical: preChainStates[finalCanonical],
    };
    const preChainApplied = JSON.parse(runIdentityCli(butlerData, "apply", preChainCommand).stdout);
    const aToBStates = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource, node_refs: [loser, canonical],
    }).stdout).states;
    const appliedCommand = { ...command, expected_loser: aToBStates[loser], expected_canonical: aToBStates[canonical] };
    const applied = runIdentityCli(butlerData, "apply", appliedCommand);
    expect(applied.status).toBe(0);
    const receipt = JSON.parse(applied.stdout);
    expect(JSON.parse(runIdentityCli(butlerData, "apply", appliedCommand).stdout).replayed).toBe(true);
    expect(runIdentityCli(butlerData, "apply", { ...appliedCommand, operation_id: "apply-stale-head" }).status).not.toBe(0);
    const preChainRevoke = runIdentityCli(butlerData, "revoke", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "revoke",
      operation_id: "revoke-b-c-before-a-b", source: { source_ref: decisionSource2, quote: "같은 고양이", occurrence: 0 },
      decision_job_ref: preChainApplied.source_job_ref, decision_ref: preChainApplied.decision_ref,
      expected_loser: aToBStates[canonical],
    });
    expect(preChainRevoke.status).toBe(0);

    const after = new Database(graphPath, { readonly: true });
    const record = JSON.parse(after.query<{ identity_decisions_json: string }, [string]>("SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?").get(receipt.source_job_ref)!.identity_decisions_json)[0];
    expect(record).toMatchObject({ node_type: "entity", identity_scope: "user", project_id: null });
    expect([record.decision_source, record.loser_source, record.canonical_source].map((item: any) => item.source_ref)).toEqual([decisionSource, loserSource, canonicalSource]);
    expect(record.loser_source.quote).toBe("루나");
    expect(record.canonical_source.quote).toBe("Luna");
    const requestScope = {
      butlerData, asOf: new Date(Date.now() + 1_000).toISOString(), scope: "all_user_sessions" as const,
      currentSessionId: "identity-session", currentProjectId: null, sessionIds: [], projectFilter: "unassigned" as const,
      projectIds: [], includeInternal: false, deadlineAt: Date.now() + 5_000,
    };
    expect(identity.resolveIdentityAt(after, loser, requestScope)).toEqual({ nodeId: canonical, partial: false });
    expect(identity.identityMembersForTarget(after, canonical, { ...requestScope, limit: 8 })).toEqual({ members: [loser], partial: false });
    expect(identity.resolveIdentityAt(after, loser, { ...requestScope, sessionIds: ["other-session"] })).toEqual({ nodeId: loser, partial: false });
    after.close();

    await Bun.sleep(5);
    const secondInspect = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource2, node_refs: [canonical, finalCanonical],
    }).stdout).states;
    const secondCommand = {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "apply",
      operation_id: "apply-normal-2", decision: "same_entity", reason: "explicit_alias",
      source: { source_ref: decisionSource2, quote: "같은 고양이", occurrence: 0 },
      loser_node_ref: canonical, canonical_node_ref: finalCanonical,
      loser_evidence: { source_ref: canonicalSource, quote: "Luna", occurrence: 0 },
      canonical_evidence: { source_ref: finalCanonicalSource, quote: "Selene", occurrence: 0 },
      expected_loser: secondInspect[canonical], expected_canonical: secondInspect[finalCanonical],
    };
    const secondApplied = runIdentityCli(butlerData, "apply", secondCommand);
    expect(secondApplied.status).toBe(0);
    const secondReceipt = JSON.parse(secondApplied.stdout);
    const transitive = new Database(graphPath, { readonly: true });
    const secondRecord = JSON.parse(transitive.query<{ identity_decisions_json: string }, [string]>("SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?").get(secondReceipt.source_job_ref)!.identity_decisions_json)
      .find((item: any) => item.decision_ref === secondReceipt.decision_ref);
    const currentScope = { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() };
    expect(identity.resolveIdentityAt(transitive, loser, currentScope)).toEqual({ nodeId: finalCanonical, partial: false });
    expect(identity.identityMembersForTarget(transitive, finalCanonical, { ...currentScope, limit: 8 }).members.sort()).toEqual([canonical, loser].sort());
    expect(identity.identityMembersForTarget(transitive, finalCanonical, { ...currentScope, limit: 1 }).partial).toBe(true);
    expect(identity.resolveIdentityAt(transitive, loser, { ...currentScope, deadlineAt: Date.now() - 1 })).toEqual({ nodeId: loser, partial: true });
    const historicalScope = { ...requestScope, asOf: new Date(Date.parse(secondRecord.recorded_at) - 1).toISOString() };
    expect(identity.resolveIdentityAt(transitive, loser, historicalScope)).toEqual({ nodeId: canonical, partial: false });
    expect(identity.identityMembersForTarget(transitive, canonical, { ...historicalScope, limit: 8 }).members).toContain(loser);
    transitive.close();

    const currentRecall = await memory.recallMemory({
      context, cue: "루나", includeVector: false, includeInternal: false, limit: 6,
      scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [], asOf: currentScope.asOf,
      runtime: { sessionId: "identity-session", turnId: "identity-current", currentUserMessage: "루나", nativeOperationId: "identity-current-op", projectId: null },
    });
    const historicalRecall = await memory.recallMemory({
      context, cue: "루나", includeVector: false, includeInternal: false, limit: 6,
      scope: "all_user_sessions", projectFilter: "unassigned", projectIds: [], sessionIds: [], asOf: historicalScope.asOf,
      runtime: { sessionId: "identity-session", turnId: "identity-old", currentUserMessage: "루나", nativeOperationId: "identity-old-op", projectId: null },
    });
    expect(currentRecall.results.flatMap((result) => result.evidence.map((evidence) => evidence.excerpt)).some((text) => text.includes("Selene"))).toBe(true);
    expect(historicalRecall.results.flatMap((result) => result.evidence.map((evidence) => evidence.excerpt)).some((text) => text.includes("Luna"))).toBe(true);

    const revoke = runIdentityCli(butlerData, "revoke", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "revoke",
      operation_id: "revoke-normal-1", source: { source_ref: decisionSource2, quote: "같은 고양이", occurrence: 0 },
      decision_job_ref: secondReceipt.source_job_ref, decision_ref: secondReceipt.decision_ref,
      expected_loser: { direct_redirect: finalCanonical, resolved_node_ref: finalCanonical, history_head: { job_ref: secondReceipt.source_job_ref, decision_ref: secondReceipt.decision_ref } },
    });
    expect(revoke.status).toBe(0);
    const afterRevoke = new Database(graphPath, { readonly: true });
    expect(identity.resolveIdentityAt(afterRevoke, canonical, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() }).nodeId).toBe(canonical);
    expect(identity.resolveIdentityAt(afterRevoke, loser, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() }).nodeId).toBe(canonical);
    afterRevoke.close();

    const reapply = runIdentityCli(butlerData, "apply", {
      ...command, operation_id: "apply-normal-3", canonical_node_ref: finalCanonical,
      canonical_evidence: { source_ref: finalCanonicalSource, quote: "Selene", occurrence: 0 },
      expected_loser: { direct_redirect: canonical, resolved_node_ref: canonical, history_head: { job_ref: receipt.source_job_ref, decision_ref: receipt.decision_ref } },
      expected_canonical: { direct_redirect: null, resolved_node_ref: finalCanonical, history_head: null },
    });
    expect(reapply.status).toBe(0);
    expect(runIdentityCli(butlerData, "apply", { ...command, operation_id: "apply-normal-3", reason: "explicit_identity_correction" }).status).not.toBe(0);
    const reapplyReceipt = JSON.parse(reapply.stdout);
    const final = new Database(graphPath, { readonly: true });
    expect(identity.resolveIdentityAt(final, loser, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() }).nodeId).toBe(finalCanonical);
    expect(identity.resolveIdentityAt(final, canonical, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() }).nodeId).toBe(canonical);
    final.close();

    const restorePreimage = runIdentityCli(butlerData, "revoke", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "revoke",
      operation_id: "revoke-normal-3", source: { source_ref: decisionSource, quote: "같은 고양이", occurrence: 0 },
      decision_job_ref: reapplyReceipt.source_job_ref, decision_ref: reapplyReceipt.decision_ref,
      expected_loser: { direct_redirect: finalCanonical, resolved_node_ref: finalCanonical, history_head: { job_ref: reapplyReceipt.source_job_ref, decision_ref: reapplyReceipt.decision_ref } },
    });
    expect(restorePreimage.status).toBe(0);
    const restored = new Database(graphPath, { readonly: true });
    expect(identity.resolveIdentityAt(restored, loser, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() })).toEqual({ nodeId: canonical, partial: false });
    restored.close();

    const repeatedInspect = JSON.parse(runIdentityCli(butlerData, "inspect", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id,
      operation: "inspect", source_ref: decisionSource, node_refs: [loser, finalCanonical],
    }).stdout).states;
    const repeatedApply = JSON.parse(runIdentityCli(butlerData, "apply", {
      ...command, operation_id: "apply-normal-4", canonical_node_ref: finalCanonical,
      canonical_evidence: { source_ref: finalCanonicalSource, quote: "Selene", occurrence: 0 },
      expected_loser: repeatedInspect[loser], expected_canonical: repeatedInspect[finalCanonical],
    }).stdout);
    const repeatedRevoke = runIdentityCli(butlerData, "revoke", {
      schema: "butler.memory-identity-command.v1", expected_generation: descriptor.generation_id, operation: "revoke",
      operation_id: "revoke-normal-4", source: { source_ref: decisionSource, quote: "같은 고양이", occurrence: 0 },
      decision_job_ref: repeatedApply.source_job_ref, decision_ref: repeatedApply.decision_ref,
      expected_loser: { direct_redirect: finalCanonical, resolved_node_ref: finalCanonical, history_head: { job_ref: repeatedApply.source_job_ref, decision_ref: repeatedApply.decision_ref } },
    });
    expect(repeatedRevoke.status).toBe(0);
    const repeatedlyRestored = new Database(graphPath, { readonly: true });
    const repeatedState = identity.resolveIdentityAt(repeatedlyRestored, loser, {
      ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString(), deadlineAt: Date.now() + 5_000,
    });
    expect(repeatedState).toEqual({ nodeId: canonical, partial: false });
    repeatedlyRestored.close();

    const canonicalDb = new Database(join(butlerData, "runtime", "conversation-store.sqlite"));
    const canonicalMessage = canonicalDb.query<{ id: string }, []>("SELECT id FROM conversation_messages WHERE turn_id='turn-luna' ORDER BY created_at LIMIT 1").get()!.id;
    canonicalDb.query("UPDATE conversation_parts SET content_json=? WHERE message_id=?").run(JSON.stringify({ text: "Luna only is still my cat." }), canonicalMessage);
    canonicalDb.close();
    const canonicalStore = new AgentConversationStore({ butlerData });
    canonicalStore.writeTurnOutcome({ sessionId: "identity-session", turnId: "turn-luna", generation: 2, outcome: "delivered", requestMessageId: canonicalMessage });
    canonicalStore.close();
    await memory.ingestConversationMemory({ context, source: { ...luna, outcome_generation: 2 }, completionJobId: "identity-grounding-revision" });
    const invalidatedGrounding = new Database(graphPath, { readonly: true });
    expect(identity.resolveIdentityAt(invalidatedGrounding, loser, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() })).toEqual({ nodeId: loser, partial: true });
    invalidatedGrounding.close();

    const staleDecisionDb = new Database(join(butlerData, "runtime", "conversation-store.sqlite"));
    const decisionAssistant = staleDecisionDb.query<{ id: string }, []>("SELECT id FROM conversation_messages WHERE turn_id='turn-decision-2' AND role='assistant' ORDER BY created_at LIMIT 1").get()!.id;
    staleDecisionDb.query("UPDATE conversation_parts SET content_json=? WHERE message_id=?").run(JSON.stringify({ text: "Companion changed before identity commit." }), decisionAssistant);
    staleDecisionDb.close();
    expect(runIdentityCli(butlerData, "apply", { ...secondCommand, operation_id: "apply-stale-decision-companion" }).status).not.toBe(0);

    const decisionDb = new Database(join(butlerData, "runtime", "conversation-store.sqlite"));
    const decisionMessage = decisionDb.query<{ id: string }, []>("SELECT id FROM conversation_messages WHERE turn_id='turn-decision-2' ORDER BY created_at LIMIT 1").get()!.id;
    decisionDb.query("UPDATE conversation_parts SET content_json=? WHERE message_id=?").run(JSON.stringify({ text: "Luna와 Selene은 이제 별개의 고양이야." }), decisionMessage);
    decisionDb.close();
    const decisionStore = new AgentConversationStore({ butlerData });
    decisionStore.writeTurnOutcome({ sessionId: "identity-session", turnId: "turn-decision-2", generation: 2, outcome: "delivered", requestMessageId: decisionMessage });
    decisionStore.close();
    const revisedDecision = await memory.ingestConversationMemory({ context, source: { ...decision2, outcome_generation: 2 }, completionJobId: "identity-revoke-source-revision" });
    const invalidatedRevoke = new Database(graphPath, { readonly: true });
    const revisedRecords = JSON.parse(invalidatedRevoke.query<{ identity_decisions_json: string }, [string]>("SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?").get(revisedDecision.job_id)!.identity_decisions_json);
    expect(revisedRecords.some((item: any) => item.operation === "invalidate" && item.target_decision?.decision_ref === JSON.parse(revoke.stdout).decision_ref)).toBe(true);
    expect(identity.resolveIdentityAt(invalidatedRevoke, canonical, { ...requestScope, asOf: new Date(Date.now() + 1_000).toISOString() }).nodeId).toBe(canonical);
    expect(invalidatedRevoke.query<{ edge_id: string; source_node_id: string; target_node_id: string; claim_node_id: string; chunk_source_id: string }, []>(`
      SELECT e.edge_id,e.source_node_id,e.target_node_id,e.claim_node_id,ee.chunk_source_id FROM edges e
      JOIN edge_evidence ee ON ee.edge_id=e.edge_id ORDER BY e.edge_id,ee.chunk_source_id
    `).all()).toEqual(typedEdgesBefore);
    invalidatedRevoke.close();
  } finally { rmSync(butlerData, { recursive: true, force: true }); }
}, 30_000);

function seedTurn(butlerData: string, turnId: string, text: string, now: string, projectId: string | null = null, sessionId = "identity-session") {
  const store = new AgentConversationStore({ butlerData });
  try {
    store.beginTurn({ gateway: "app", externalSessionId: sessionId, sessionId, projectId, actor: "user", turnId, now });
    const message = store.appendUserMessage({ sessionId, turnId, text, originKind: "user_input", originRef: "test", now });
    const assistant = store.appendAssistantMessage({ sessionId, turnId, text: "Acknowledged.", originKind: "assistant_public", originRef: "test", now });
    store.finalizeTurn({ turnId, status: "complete", outcomeCapsule: { sessionId, turnId, generation: 1, outcome: "delivered", requestMessageId: message.id, publicAssistantMessageId: assistant.id } });
    return { kind: "conversation_turn" as const, session_id: sessionId, turn_id: turnId, outcome_generation: 1 };
  } finally { store.close(); }
}

function memoryState(butlerData: string, generation: string, jobId: string): string {
  const db = new Database(join(butlerData, "cognition", "memory", "generations", generation, "graph.sqlite"), { readonly: true });
  try { return JSON.parse(db.query<{ semantic_graph_state: string }, [string]>("SELECT semantic_graph_state FROM memory_projection_jobs WHERE job_id=?").get(jobId)!.semantic_graph_state).state; }
  finally { db.close(); }
}

function runIdentityCli(butlerData: string, operation: string, command: unknown) {
  const input = join(butlerData, `identity-${operation}-${crypto.randomUUID()}.json`);
  writeFileSync(input, JSON.stringify(command));
  return spawnSync("bun", ["packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts", "--memory-identity", operation, "--input", input], {
    cwd: join(import.meta.dir, "../.."), env: { ...process.env, BUTLER_DATA: butlerData, EMBED_SOCKET: join(butlerData, "no-embed.sock") }, encoding: "utf8",
  });
}
