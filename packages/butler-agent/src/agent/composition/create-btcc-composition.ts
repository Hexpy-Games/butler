import {
  agentBtccStoragePaths,
  createProjectLedgerLegacyWorkSource,
  openBtccSqliteStores,
} from "../adapters/index.ts";
import { createBtcc } from "../btcc/index.ts";
import {
  createTurnRuntime,
  DefaultBtccTurnPreparation,
  type BtccTurnPreparationDependencies,
} from "../btcc/turn/index.ts";
import { createProductionGuidedTurnAgent } from "../btcc/agent-loop/index.ts";
import type { ModelRoundPort } from "../btcc/agent-loop/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../integrations/project-ledger/active-project-ledger-reference.ts";
import { AgentConversationStore } from "../conversation/index.ts";
import { PromptAssembler } from "../prompt/prompt-assembler.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import {
  loadPrivateInstallationKey,
  privateInstallationDigest,
} from "../../integrations/providers/shared/private-installation-identity.ts";
import {
  createRuntimeMemoryAttributionPort,
  type RuntimeMemoryAttributionPort,
} from "../../operations/diagnostics/runtime-memory-attribution/index.ts";
import {
  createAppParentInputSink,
  createSubsessionDelegationService,
} from "../btcc/subsessions/index.ts";
import { resolveAppGatewayRuntimeConfig } from "../../operations/gateway/registry.ts";
import { readLocalAuthConfigFromEnvironment } from "../../gateways/app/interface/server/local-auth.ts";

/**
 * Production wiring only.  Lifecycle policy lives in `agent/btcc/btcc.ts`
 * and `agent/btcc/turn/turn.ts`; this function supplies stores and adapters.
 */
export function createProductionBtccComposition(input: {
  butlerHome: string;
  butlerData: string;
  ownerId: string;
  /** Test-only one-round provider seam; production callers omit it. */
  modelRound?: ModelRoundPort;
  memoryAttribution?: RuntimeMemoryAttributionPort;
  sessionBindings?: SessionBindingStore;
  conversationStore?: AgentConversationStore;
  appServerUrl?: string;
  appLocalAuth?: import("../../gateways/app/interface/server/local-auth.ts").LocalAuthConfig;
}) {
  let phaseContinuityKey: Buffer | undefined;
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const legacyProjectWorkSource = createProjectLedgerLegacyWorkSource({
    butlerData: input.butlerData,
    resolver: projectLedgerResolver,
  });
  const stores = openBtccSqliteStores({
    dbPath: agentBtccStoragePaths(input.butlerData).agentBtccDbPath,
    ownerId: input.ownerId,
    legacyProjectWorkSource,
  });
  const bindings = input.sessionBindings ?? new SessionBindingStore(
    `${input.butlerData}/runtime/session-store.sqlite`,
  );
  const subsessions = createSubsessionDelegationService({
    butlerData: input.butlerData,
    sessionBindings: bindings,
    durableWork: stores.durableWork,
    store: stores.subsessionStore,
    parentInputSink: createAppParentInputSink({
      appServerUrl: input.appServerUrl ?? resolveAppGatewayRuntimeConfig({
        butlerData: input.butlerData,
      }).serverUrl,
      localAuth: input.appLocalAuth ?? readLocalAuthConfigFromEnvironment(),
    }),
    toolJournal: stores.guidedToolJournal,
    effectJournal: stores.guidedEffectJournal,
    parentTurns: stores.turns,
    contextDocuments: stores.contextDocuments,
  });
  const conversations = input.conversationStore ?? new AgentConversationStore({
    butlerData: input.butlerData,
  });
  const promptAssembler = new PromptAssembler({
    butlerHome: input.butlerHome,
    butlerData: input.butlerData,
  });
  const memoryAttribution = input.memoryAttribution ?? createRuntimeMemoryAttributionPort({
    butlerData: input.butlerData,
  });
  const runtime = createTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    memoryAttribution,
    agent: createProductionGuidedTurnAgent({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      phaseContinuityPrivateDigester: {
        digest(fieldDomain, exactUtf8Bytes) {
          phaseContinuityKey ??= loadPrivateInstallationKey(input.butlerData);
          return privateInstallationDigest(
            phaseContinuityKey,
            "phase-continuity-projection-v1",
            `${fieldDomain}\0${exactUtf8Bytes}`,
          );
        },
      },
      contextDocuments: stores.contextDocuments,
      toolJournal: stores.guidedToolJournal,
      operationResultReader: stores.guidedOperationResultReader,
      effectJournal: stores.guidedEffectJournal,
      durableWork: stores.durableWork,
      authority: stores.authority,
      modelRound: input.modelRound,
      sessionBindingStore: bindings,
      subsessionDelegation: subsessions,
    }),
  });
  const preparationDependencies: BtccTurnPreparationDependencies = {
    bindingStore: bindings,
    conversationStore: conversations,
    butlerData: input.butlerData,
    promptAssembler,
    contextDocuments: stores.contextDocuments,
    turns: stores.turns,
    wakeAuthorizations: stores.wakeAuthorizations,
  };
  const assembly = createBtcc({
    runtime,
    preparation: new DefaultBtccTurnPreparation(preparationDependencies),
    progressEvents: stores.progressEvents,
    turns: stores.turns,
    close: async () => {
      memoryAttribution.close();
      stores.close();
      if (!input.conversationStore) conversations.close();
      if (!input.sessionBindings) bindings.close();
    },
  });
  return {
    btcc: assembly.btcc,
    host: assembly.host,
    // A persisted Steward result may have committed its outbox just before
    // process loss. Re-enter that same durable handoff once at composition
    // startup; the App queue remains the sole owner after admission.
    ready: subsessions.recoverPendingParentInputs().then(() => undefined),
    authority: stores.authority,
    subsessions,
  };
}

export type BtccComposition = ReturnType<typeof createProductionBtccComposition>;
