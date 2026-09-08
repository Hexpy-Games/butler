#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import type {
  BtccInboundDispatcher,
  BtccInboundDispatchOptions,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";

const S1 = "내 고양이 루나의 영어 이름은 Luna야.";
const S2 = "Luna likes the blue ball.";

export async function runMemoryRecoveryDispatcherHarness(dataRoot: string) {
  const butlerData = resolve(dataRoot);
  if (!dataRoot.trim()) throw new Error("--data-root is required");
  if (existsSync(butlerData)) {
    throw new Error("dispatcher harness requires a fresh nonexistent data root");
  }
  process.env.BUTLER_DATA = butlerData;
  mkdirSync(butlerData, { recursive: true, mode: 0o700 });

  const [
    { createProductionBtccComposition },
    { BtccInboundDispatcher, createBtccGatewayHandlers },
    { createAppTransportAdapter },
    { DeliveryGuard },
    { createGatewayServer },
    { GatewayRouter },
    { NativeInboundQueue },
    { createAppServer },
    { SessionBindingStore },
    { AgentConversationStore },
  ] = await Promise.all([
    import("../../packages/butler-agent/src/agent/composition/index.ts"),
    import("../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/app/adapter.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts"),
    import("../../packages/butler-agent/src/gateways/core/server.ts"),
    import("../../packages/butler-agent/src/gateways/core/router.ts"),
    import("../../packages/butler-agent/src/gateways/core/inbound-queue.ts"),
    import("../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts"),
    import("../../packages/butler-agent/src/test-support/harness/session-store.ts"),
    import("../../packages/butler-agent/src/agent/conversation/store.ts"),
  ]);
  markExecutorReady(butlerData);
  let modelCalls = 0;
  const bindings = new SessionBindingStore(
    `${butlerData}/runtime/session-store.sqlite`,
    "ephemeral",
  );
  const app = createAppServer({
    dbPath: `${butlerData}/app.sqlite`,
    butlerData,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData,
    ownerId: `memory-dispatcher:${process.pid}`,
    modelRound: {
      async runRound() {
        modelCalls += 1;
        return final("합성 dispatcher 확인 응답입니다.");
      },
    },
    sessionBindings: bindings,
    appServerUrl: app.url,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData,
  });

  try {
    await composition.ready;
    const summary = await sendAndDispatch(
      app.url,
      S1,
      new BtccInboundDispatcher(),
      {
        queue: new NativeInboundQueue(butlerData),
        server: gateway,
        store: bindings,
        deliveryGuard: new DeliveryGuard({
          adapters: [createAppTransportAdapter()],
          butlerData,
        }),
      },
    );
    const canonical = new AgentConversationStore({ butlerData });
    try {
      const sessions = canonical.listSessions();
      const messages = sessions.length === 1
        ? canonical.readMessages({ sessionId: sessions[0]!.id })
        : [];
      if (messages.length !== 2 || modelCalls !== 1) {
        throw new Error("dispatcher harness did not persist one completed turn");
      }
    } finally {
      canonical.close();
    }
    return {
      ok: true,
      claimed: summary.claimed,
      handled: summary.handled,
      failed: summary.failed,
      modelCalls,
    };
  } finally {
    await composition.host.close();
    app.stop();
    bindings.close();
  }
}

export async function runMemoryRecoveryLiveHarness(dataRoot: string) {
  const butlerData = resolve(dataRoot);
  if (!dataRoot.trim()) throw new Error("--data-root is required");
  if (existsSync(butlerData)) {
    throw new Error("live harness requires a fresh nonexistent data root");
  }
  process.env.BUTLER_DATA = butlerData;
  if (resolve(process.env.BUTLER_DATA) !== butlerData) {
    throw new Error("live harness data root binding failed");
  }
  mkdirSync(butlerData, { recursive: true, mode: 0o700 });
  const configPath = `${butlerData}/butler.config.json`;
  if (existsSync(configPath)) throw new Error("live harness config exists");
  writeFileSync(
    configPath,
    JSON.stringify({
      system: { butlerModel: "openai/gpt-5.5" },
      personalization: {
        profiling: {
          mode: "off",
          extractorModel: "openai/gpt-5.6-sol",
          extractorReasoningEffort: "medium",
        },
      },
    }),
  );
  const cli = resolve(
    "packages/butler-agent/src/agent/cognition/memory/scripts/consolidation-cycle.ts",
  );
  const initialized = Bun.spawnSync(
    [process.execPath, cli, "--memory-rebuild", "initialize-empty"],
    {
      cwd: process.cwd(),
      env: { ...process.env, BUTLER_DATA: butlerData },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (initialized.exitCode !== 0) {
    throw new Error("memory live initialize-empty CLI failed");
  }
  const initializedOutput = JSON.parse(initialized.stdout.toString());
  const descriptor = initializedOutput.descriptor;
  if (!initializedOutput.ok || !descriptor?.generation_id) {
    throw new Error("memory live initialize-empty CLI returned invalid output");
  }
  const graphPath = `${butlerData}/cognition/memory/generations/${descriptor.generation_id}/graph.sqlite`;

  const [
    { createProductionBtccComposition },
    { BtccInboundDispatcher, createBtccGatewayHandlers },
    { createAppTransportAdapter },
    { DeliveryGuard },
    { createGatewayServer },
    { GatewayRouter },
    { NativeInboundQueue },
    { createAppServer },
    { SessionBindingStore },
    { pollIteration },
    { AgentConversationStore },
    { conversationMessageText },
  ] = await Promise.all([
    import("../../packages/butler-agent/src/agent/composition/index.ts"),
    import("../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/app/adapter.ts"),
    import("../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts"),
    import("../../packages/butler-agent/src/gateways/core/server.ts"),
    import("../../packages/butler-agent/src/gateways/core/router.ts"),
    import("../../packages/butler-agent/src/gateways/core/inbound-queue.ts"),
    import("../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts"),
    import("../../packages/butler-agent/src/test-support/harness/session-store.ts"),
    import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts"),
    import("../../packages/butler-agent/src/agent/conversation/store.ts"),
    import("../../packages/butler-agent/src/agent/conversation/message-text.ts"),
  ]);
  markExecutorReady(butlerData);

  const dbPath = `${butlerData}/app.sqlite`;
  const bindings = new SessionBindingStore(
    `${butlerData}/runtime/session-store.sqlite`,
    "ephemeral",
  );
  const toolTrace: {
    entityRecall?: any;
    claimRecall?: any;
    returnedReadArgs?: any;
    submittedReadArgs?: any;
    read?: any;
  } = {};
  let modelCalls = 0;
  let projectionPolls = 0;
  const modelRound: ModelRoundPort = {
    async runRound(request) {
      modelCalls += 1;
      if (modelCalls === 1) return final("첫 번째 합성 기억을 확인했습니다.");
      if (modelCalls === 2) return final("두 번째 합성 기억을 확인했습니다.");
      if (modelCalls === 3) {
        return tools([
          {
            id: "recall-entity-live",
            name: "recall_memory",
            args: { cue: "Luna", include_vector: false, limit: 6 },
          },
          {
            id: "recall-claim-live",
            name: "recall_memory",
            args: { cue: "Luna likes", include_vector: false, limit: 6 },
          },
        ]);
      }
      if (modelCalls === 4) {
        toolTrace.entityRecall = toolOutputById(request, "recall-entity-live");
        toolTrace.claimRecall = toolOutputById(request, "recall-claim-live");
        const preferenceEvidence = toolTrace.claimRecall.results
          .flatMap((result: any) => result.evidence)
          .find((item: any) => item.excerpt.includes("blue ball"));
        if (!preferenceEvidence)
          throw new Error("recall did not resolve S2 preference evidence");
        toolTrace.returnedReadArgs = preferenceEvidence.read_args;
        return tool(
          "read-live",
          "read_conversation_session",
          structuredClone(toolTrace.returnedReadArgs),
        );
      }
      if (modelCalls === 5) {
        toolTrace.submittedReadArgs = toolCallById(request, "read-live").arguments;
        toolTrace.read = lastToolOutput(request, "read_conversation_session");
        return final(
          "Luna의 파란 공 선호 근거를 canonical source에서 확인했습니다.",
        );
      }
      throw new Error("unexpected model round");
    },
  };
  const app = createAppServer({
    dbPath,
    butlerData,
    butlerHome: process.cwd(),
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  const composition = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData,
    ownerId: `memory-live:${process.pid}`,
    modelRound,
    sessionBindings: bindings,
    appServerUrl: app.url,
  });
  const gateway = createGatewayServer({
    router: new GatewayRouter({ store: bindings }),
    handlers: createBtccGatewayHandlers({ btcc: composition.btcc }),
    butlerData,
  });
  const dispatcher = new BtccInboundDispatcher();
  const queue = new NativeInboundQueue(butlerData);
  const deliveryGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData,
  });

  try {
    await composition.ready;
    await sendAndDispatch(app.url, S1, dispatcher, {
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
    });
    await requireProjectionPoll(butlerData, graphPath, 1, pollIteration);
    projectionPolls += 1;
    await sendAndDispatch(app.url, S2, dispatcher, {
      queue,
      server: gateway,
      store: bindings,
      deliveryGuard,
    });
    await requireProjectionPoll(butlerData, graphPath, 2, pollIteration);
    projectionPolls += 1;
    await sendAndDispatch(
      app.url,
      "What does Luna like? Read the canonical evidence.",
      dispatcher,
      { queue, server: gateway, store: bindings, deliveryGuard },
    );

    const db = new Database(graphPath, { readonly: true });
    let evidence: Array<Record<string, unknown>>;
    let counts: Record<string, number>;
    let linkage: Record<string, string>;
    try {
      evidence = db
        .query<{ provider_evidence_json: string }, []>(
          "SELECT provider_evidence_json FROM memory_projection_windows ORDER BY rowid",
        )
        .all()
        .map((row) => JSON.parse(row.provider_evidence_json));
      counts = {
        episodes: Number(
          db
            .query<{ n: number }, []>("SELECT COUNT(*) n FROM memory_chunks")
            .get()!.n,
        ),
        aliases: Number(
          db
            .query<{ n: number }, []>("SELECT COUNT(*) n FROM entity_aliases")
            .get()!.n,
        ),
        alias_surfaces: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(DISTINCT surface_original) n FROM entity_aliases WHERE surface_original IN ('루나','Luna')")
            .get()!.n,
        ),
        shared_alias_entity: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM (SELECT entity_id FROM entity_aliases WHERE surface_original IN ('루나','Luna') GROUP BY entity_id HAVING COUNT(DISTINCT surface_original)=2)")
            .get()!.n,
        ),
        likes: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='likes'")
            .get()!.n,
        ),
        has_subject: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='has_subject'")
            .get()!.n,
        ),
        has_object: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edges WHERE rel_type='has_object'")
            .get()!.n,
        ),
        likes_evidence: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(*) n FROM edge_evidence ee JOIN edges e ON e.edge_id=ee.edge_id WHERE e.rel_type='likes'")
            .get()!.n,
        ),
        reused_luna_likes: Number(
          db
            .query<
              { n: number },
              []
            >("SELECT COUNT(DISTINCT e.edge_id) n FROM edges e JOIN entity_aliases a ON a.entity_id=e.source_node_id WHERE e.rel_type='likes' AND a.surface_original='Luna'")
            .get()!.n,
        ),
        s2_typed_claim_support: Number(
          db
            .query<
              { n: number },
              [string]
            >("SELECT COUNT(DISTINCT e.claim_node_id) n FROM edges e JOIN edge_evidence ee ON ee.edge_id=e.edge_id JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id WHERE s.source_id=? AND e.rel_type IN ('likes','has_subject','has_object') GROUP BY e.claim_node_id HAVING COUNT(DISTINCT e.rel_type)=3")
            .get(toolTrace.read.source_ref)?.n ?? 0,
        ),
      };
      linkage = db
        .query<
          {
            source_id: string;
            episode_id: string;
            revision: string;
            job_id: string;
            window_ref: string;
            conversation_session_id: string;
            conversation_turn_id: string;
            observed_completion_job_ids: string;
            normalized_plan_json: string;
          },
          [string]
        >(
          "SELECT s.source_id,s.episode_id,s.revision,j.job_id,w.window_ref,c.conversation_session_id,c.conversation_turn_id,j.observed_completion_job_ids,w.normalized_plan_json FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id JOIN memory_projection_jobs j ON j.episode_id=s.episode_id AND j.revision=s.revision JOIN memory_projection_windows w ON w.job_id=j.job_id JOIN json_each(w.source_refs_json) refs ON refs.value=s.source_id WHERE s.source_id=?",
        )
        .get(toolTrace.read.source_ref)!;
    } finally {
      db.close();
    }
    if (
      counts.episodes !== 2 ||
      counts.alias_surfaces < 2 ||
      counts.shared_alias_entity !== 1 ||
      counts.likes < 1 ||
      counts.likes_evidence < 1 ||
      counts.reused_luna_likes < 1 ||
      counts.has_subject < 1 ||
      counts.has_object < 1
      || counts.s2_typed_claim_support < 1
    ) {
      throw new Error(
        `typed graph acceptance failed: ${JSON.stringify(counts)}`,
      );
    }
    if (evidence.length > 8)
      throw new Error("extractor window budget exceeded");
    if (projectionPolls !== 2 || evidence.length !== 2) {
      throw new Error("memory live projection attempt count mismatch");
    }
    const claimPath = toolTrace.claimRecall.results
      .flatMap((result: any) => result.association_path)
      .find((edge: any) =>
        ["likes", "has_subject", "has_object"].includes(edge.relation),
      );
    if (!claimPath) {
      throw new Error("native claim seed did not return a typed graph path");
    }
    if (
      toolTrace.read?.mode !== "source" ||
      JSON.stringify(toolTrace.returnedReadArgs) !==
        JSON.stringify(toolTrace.submittedReadArgs)
    ) {
      throw new Error(
        "native source read did not complete from unchanged recall read_args",
      );
    }
    const canonical = new AgentConversationStore({ butlerData });
    let canonicalS2: string;
    let outcomeId: string;
    try {
      const message = canonical.readMessageById(
        toolTrace.read.conversation_message_id,
      );
      canonicalS2 = message ? conversationMessageText(message) : "";
      outcomeId = canonical.readTurnOutcome(linkage.conversation_turn_id)?.id ?? "";
    } finally {
      canonical.close();
    }
    if (
      canonicalS2 !== S2 ||
      !outcomeId ||
      toolTrace.read.text !== canonicalS2 ||
      toolTrace.read.source_hash !== sha(canonicalS2) ||
      toolTrace.read.byte_start !== 0 ||
      toolTrace.read.byte_end !== Buffer.byteLength(canonicalS2, "utf8")
    ) {
      throw new Error("native source read does not match canonical S2 scalar");
    }
    const trace = {
      schema: "butler.memory-recovery-t1-live-trace.v1",
      data_root: butlerData,
      generation_id: descriptor.generation_id,
      app_ingress_turns: 3,
      projection_polls: projectionPolls,
      extraction_windows: evidence.length,
      provider_attempts: evidence.map((item, index) => ({
        ordinal: index,
        ...item,
        schema_retry_count: 0,
        quote_retry_count: 0,
      })),
      configured_extractor: "openai/gpt-5.6-sol",
      reasoning_effort: "medium",
      provider_evidence: evidence,
      graph_counts: counts,
      entity_recall_status: toolTrace.entityRecall.status,
      claim_recall_status: toolTrace.claimRecall.status,
      vector_coverage: toolTrace.claimRecall.coverage.vectors.state,
      claim_seed_typed_path: {
        relation: claimPath.relation,
        traversed_reverse: claimPath.traversed_reverse,
      },
      read_args_sha256: sha(JSON.stringify(toolTrace.returnedReadArgs)),
      source_ref_sha256: sha(toolTrace.read.source_ref),
      source_hash: toolTrace.read.source_hash,
      source_bytes: Buffer.byteLength(toolTrace.read.text, "utf8"),
      linkage_sha256: {
        source: sha(linkage.source_id),
        episode: sha(linkage.episode_id),
        revision: sha(linkage.revision),
        job: sha(linkage.job_id),
        window: sha(linkage.window_ref),
        app_session: sha(linkage.conversation_session_id),
        btcc_turn: sha(linkage.conversation_turn_id),
        canonical_outcome: sha(outcomeId),
        completion_jobs: sha(linkage.observed_completion_job_ids),
        normalized_plan: sha(linkage.normalized_plan_json),
      },
      model_round_calls: modelCalls,
      model_round_driver: "deterministic",
      extractor_execution: "configured_provider",
      executor_readiness_precondition: "existing_native_marker",
      raw_personal_text_included: false,
    };
    const tracePath = `${butlerData}/memory-t1-live-trace.json`;
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
    return {
      ...trace,
      trace_path: tracePath,
      trace_sha256: sha(readFileSync(tracePath, "utf8")),
    };
  } finally {
    await composition.host.close();
    app.stop();
    bindings.close();
  }
}

async function sendAndDispatch(
  url: string,
  text: string,
  dispatcher: BtccInboundDispatcher,
  dependencies: Pick<
    BtccInboundDispatchOptions,
    "queue" | "server" | "store" | "deliveryGuard"
  >,
) {
  const response = await fetch(`${url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: "general", text }),
  });
  if (response.status !== 202)
    throw new Error(`App message ingress failed: ${response.status}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const summary = dispatcher.poll({ ...dependencies, limit: 1 });
    if (summary.claimed > 0) {
      await dispatcher.waitForIdle();
      if (summary.handled !== 1 || summary.failed !== 0)
        throw new Error(`BTCC dispatch failed: ${JSON.stringify(summary)}`);
      return summary;
    }
    await Bun.sleep(25);
  }
  throw new Error("App message did not reach native inbound queue");
}

async function requireProjectionPoll(
  butlerData: string,
  graphPath: string,
  expectedJobs: number,
  poll: (input: { butlerData: string }) => Promise<{ action: string }>,
) {
  const result = await poll({ butlerData });
  if (result.action !== "processed")
    throw new Error(`memory projection poll did not process: ${result.action}`);
  const db = new Database(graphPath, { readonly: true });
  try {
    const state = db
      .query<
        { jobs: number; windows: number; complete: number; failed: number },
        []
      >(
        "SELECT (SELECT COUNT(*) FROM memory_projection_jobs) jobs,COUNT(*) windows,SUM(state='complete') complete,SUM(state IN ('failed','unsupported')) failed FROM memory_projection_windows",
      )
      .get()!;
    if (
      Number(state.jobs) !== expectedJobs ||
      Number(state.windows) !== expectedJobs ||
      Number(state.complete) !== expectedJobs ||
      Number(state.failed) !== 0
    ) {
      throw new Error(
        `memory projection did not complete expected quantum: ${JSON.stringify(state)}`,
      );
    }
  } finally {
    db.close();
  }
}

function final(text: string): ModelRoundResult {
  return { text, toolCalls: [] };
}

function tool(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelRoundResult {
  return {
    text: "",
    toolCalls: [
      { id, name, arguments: args, rawArguments: JSON.stringify(args) },
    ],
  };
}

function tools(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): ModelRoundResult {
  return {
    text: "",
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args,
      rawArguments: JSON.stringify(call.args),
    })),
  };
}

function toolCallById(request: ModelRoundRequest, id: string) {
  const call = request.messages
    .flatMap((message) => message.toolCalls ?? [])
    .find((item) => item.id === id);
  if (!call) throw new Error(`missing tool call: ${id}`);
  return call;
}

function toolOutputById(request: ModelRoundRequest, id: string): any {
  const message = request.messages.find(
    (item) => item.role === "tool" && item.toolCallId === id,
  );
  if (!message) throw new Error(`missing tool result: ${id}`);
  const result = JSON.parse(message.content);
  return result.output ?? result;
}

function lastToolOutput(request: ModelRoundRequest, name: string): any {
  const message = request.messages
    .filter((item) => item.role === "tool" && item.name === name)
    .at(-1);
  if (!message) throw new Error(`missing tool result: ${name}`);
  const result = JSON.parse(message.content);
  return result.output ?? result;
}

function markExecutorReady(root: string): void {
  mkdirSync(`${root}/state`, { recursive: true });
  writeFileSync(
    `${root}/state/butler-main-native.json`,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runtime: "memory-recovery-live-harness",
      launcher: "memory-recovery-multilingual-live-e2e",
    }),
  );
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) {
  const index = process.argv.indexOf("--data-root");
  const dataRoot = index >= 0 ? (process.argv[index + 1] ?? "") : "";
  const dispatcherOnly = process.argv.includes("--dispatcher-only");
  process.stdout.write(
    `${JSON.stringify(
      dispatcherOnly
        ? await runMemoryRecoveryDispatcherHarness(dataRoot)
        : await runMemoryRecoveryLiveHarness(dataRoot),
    )}\n`,
  );
}
