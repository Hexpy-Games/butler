import type {
  BtccTurnProgressObserver,
  BtccTurnRuntime,
} from "../../../agent/btcc/index.ts";
import type { PromptAssembler } from "../../../agent/prompt/prompt-assembler.ts";
import type { RuntimeTurnEventInput } from "../../../agent/events/turn-events.ts";
import type {
  InboundEnvelope,
  StoredSessionBinding,
} from "../../../test-support/harness/contracts.ts";
import type { GatewayRoute } from "../../../gateways/core/contracts.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import type { GatewayConversationStore } from "./conversation/index.ts";
import type { ContextDocumentWriter } from "./context-documents.ts";

export type BtccGatewayRuntime = {
  runtime: BtccTurnRuntime;
  contextDocuments: ContextDocumentWriter;
  observeTurn(turnId: string, observer: BtccTurnProgressObserver): () => void;
  close(): void;
};

export type BtccGatewayBinding = Pick<
  BtccGatewayRuntime,
  "runtime" | "contextDocuments" | "observeTurn"
>;

export type BtccGatewayActorOptions = BtccGatewayBinding & {
  binding: StoredSessionBinding;
  store: SessionBindingStore;
  conversationStore: GatewayConversationStore;
  butlerData: string;
  promptAssembler: Pick<PromptAssembler, "buildButlerContextAssembly">;
  deliverTurnEvent?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
    event: RuntimeTurnEventInput;
  }) => Promise<void>;
  generateSessionTitle?: (input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    route?: GatewayRoute;
  }) => Promise<string | null>;
};
