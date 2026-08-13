import type { InboundEnvelope, SessionTransportBinding } from
  "../../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from
  "../../../test-support/harness/session-store.ts";

export function bindQueuedInboundSession(
  envelope: InboundEnvelope,
  store: SessionBindingStore,
): void {
  if (envelope.appTurnContext) bindAppTurn(envelope, store);
  else if (envelope.nativeStewardContext) bindStewardTurn(envelope, store);
}

function bindAppTurn(envelope: InboundEnvelope, store: SessionBindingStore): void {
  const context = envelope.appTurnContext!;
  const controls = envelope.executionControls;
  const sessionId = envelope.routingHints?.sessionId?.trim();
  if (!sessionId || !controls) throw new Error("queued_app_turn_context_missing");
  const existing = store.getBySessionId(sessionId);
  const modelRef = controls.model_ref;
  store.upsert({
    sessionId,
    role: existing?.role ?? "butler",
    projectId: context.project?.id ?? existing?.projectId,
    workspacePath: context.project?.workspacePath ?? existing?.workspacePath ?? process.cwd(),
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: modelRef.split("/", 1)[0] || "openai",
    modelRef,
    runtimeSessionRef: existing?.runtimeSessionRef,
    providerThreadRef: existing?.providerThreadRef,
    lifecycleState: "active",
    transportBindings: mergeBindings(existing?.transportBindings ?? [], {
      transport: envelope.transport,
      accountId: envelope.accountId,
      peerId: envelope.peer.id,
    }),
    metadata: {
      ...(existing?.metadata ?? {}),
      source: "native-butler-queued-app-context",
      appSessionKind: context.session.kind,
      accessMode: controls.access_mode,
      reasoning_effort: controls.reasoning_effort,
      plan_mode: controls.plan_mode,
      turnExecutionControls: controls,
      runtimePolicy: runtimePolicy(context.session.kind, Boolean(context.project), controls.access_mode),
    },
  });
}

function bindStewardTurn(envelope: InboundEnvelope, store: SessionBindingStore): void {
  const context = envelope.nativeStewardContext!;
  const sessionId = envelope.routingHints?.stewardId?.trim();
  if (!sessionId) throw new Error("queued_steward_context_missing");
  const existing = store.getBySessionId(sessionId);
  store.upsert({
    sessionId,
    role: "steward",
    projectId: context.projectName,
    workspacePath: context.workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: existing?.modelProviderId ?? "openai",
    modelRef: existing?.modelRef ?? "openai/auto:codex-latest",
    runtimeSessionRef: existing?.runtimeSessionRef,
    providerThreadRef: existing?.providerThreadRef,
    lifecycleState: "active",
    transportBindings: mergeBindings(existing?.transportBindings ?? [], {
      transport: envelope.transport,
      accountId: envelope.accountId,
      peerId: envelope.peer.parentId ?? envelope.peer.id,
      threadId: envelope.peer.kind === "thread" ? envelope.peer.id : undefined,
    }),
    metadata: { ...(existing?.metadata ?? {}), source: "native-butler-queued-steward-context" },
  });
}

function runtimePolicy(
  sessionKind: "chat" | "project",
  hasProject: boolean,
  accessMode: string,
): Record<string, unknown> {
  const trackingMode = hasProject ? "ledger" : "local";
  const profiles = accessMode === "full_access"
    ? hasProject ? ["workspace", "project", "project-lifecycle"] : ["workspace"]
    : hasProject ? ["project"] : [];
  return {
    accessMode,
    trackingMode,
    tracking_mode: trackingMode,
    trackingModeSource: hasProject ? "app_project_default" : sessionKind === "project" ? "project_shell_default" : "session_default",
    tracking_mode_source: hasProject ? "app_project_default" : sessionKind === "project" ? "project_shell_default" : "session_default",
    closeoutStrategy: hasProject ? "ledger" : "local_workstream",
    closeout_strategy: hasProject ? "ledger" : "local_workstream",
    thinFirstResponse: true,
    thin_first_response: true,
    requiredNativeTools: [],
    required_tools: [],
    requiredNativeToolProfiles: profiles,
  };
}

function mergeBindings(
  existing: SessionTransportBinding[],
  next: SessionTransportBinding,
): SessionTransportBinding[] {
  return [...existing.filter((item) => !(
    item.transport === next.transport && item.accountId === next.accountId &&
    item.peerId === next.peerId && item.threadId === next.threadId
  )), next];
}
