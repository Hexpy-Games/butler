import {
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

type BtccStores = ReturnType<typeof openBtccSqliteStores>;

/**
 * Production wiring only.  Lifecycle policy lives in `agent/btcc/btcc.ts`
 * and `agent/btcc/turn/turn.ts`; this function supplies stores and adapters.
 */
export function createProductionBtccComposition(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  ownerId: string;
  /** Test-only one-round provider seam; production callers omit it. */
  modelRound?: ModelRoundPort;
  sessionBindings?: SessionBindingStore;
  conversationStore?: AgentConversationStore;
}) {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const legacyProjectWorkSource = createProjectLedgerLegacyWorkSource({
    butlerData: input.butlerData,
    appMessageDbPath: input.appMessageDbPath,
    resolver: projectLedgerResolver,
  });
  const stores = openBtccSqliteStores({
    dbPath: input.appMessageDbPath,
    ownerId: input.ownerId,
    legacyProjectWorkSource,
  });
  const bindings = input.sessionBindings ?? new SessionBindingStore(
    `${input.butlerData}/runtime/session-store.sqlite`,
  );
  const conversations = input.conversationStore ?? new AgentConversationStore({
    butlerData: input.butlerData,
  });
  const promptAssembler = new PromptAssembler({
    butlerHome: input.butlerHome,
    butlerData: input.butlerData,
  });
  const runtime = createTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    agent: createProductionGuidedTurnAgent({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      contextDocuments: stores.contextDocuments,
      toolJournal: stores.guidedToolJournal,
      effectJournal: stores.guidedEffectJournal,
      durableWork: stores.durableWork,
      modelRound: input.modelRound,
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
      stores.close();
      if (!input.conversationStore) conversations.close();
      if (!input.sessionBindings) bindings.close();
    },
  });
  return {
    btcc: assembly.btcc,
    host: assembly.host,
    ready: Promise.resolve(),
  };
}

export type BtccComposition = ReturnType<typeof createProductionBtccComposition>;
