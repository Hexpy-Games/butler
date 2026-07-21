import type {
  GatewayRoute,
  GatewaySessionActor,
} from "../../../gateways/core/contracts.ts";
import { BtccGatewaySessionActor } from "./btcc-session-actor.ts";
import type { BtccGatewayActorOptions, BtccGatewayBinding } from "./contracts.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import type { PromptAssembler } from "../../../agent/prompt/prompt-assembler.ts";

type LifecycleOptions = BtccGatewayBinding & Pick<
  BtccGatewayActorOptions,
  "deliverTurnEvent" | "generateSessionTitle"
> & {
  store: SessionBindingStore;
  promptAssembler: Pick<PromptAssembler, "buildButlerContextAssembly">;
};

export class BtccGatewayLifecycleService {
  private readonly actors = new Map<string, GatewaySessionActor>();

  constructor(private readonly options: LifecycleOptions) {}

  actorForRoute(route: GatewayRoute): Promise<GatewaySessionActor> {
    return this.getOrCreate(route.sessionId, route.role);
  }

  async getOrCreate(
    sessionId: string,
    expectedRole?: GatewayRoute["role"],
  ): Promise<GatewaySessionActor> {
    const existing = this.actors.get(sessionId);
    if (existing) return existing;
    const binding = this.options.store.getBySessionId(sessionId);
    if (!binding) throw new Error(`Missing stored session binding for ${sessionId}`);
    if (expectedRole && binding.role !== expectedRole) {
      throw new Error(`Stored session ${sessionId} has role ${binding.role}, expected ${expectedRole}`);
    }
    const actor = new BtccGatewaySessionActor({
      ...this.options,
      binding,
    });
    this.actors.set(sessionId, actor);
    return actor;
  }

  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;
    await actor.close(reason);
    this.actors.delete(sessionId);
  }
}
