import type { BtccTurnPreparation, BtccTurnRequest, BtccPreparedTurn } from "../btcc/contracts.ts";
import type { LocalAuthConfig } from "../../gateways/app/interface/server/local-auth.ts";
import type { TurnStateRepository } from "../btcc/turn/contracts.ts";

/** Mandatory production adapter: App and runtime cannot admit different session contexts. */
export class AppContextPreparation implements BtccTurnPreparation {
  constructor(private readonly preparation: BtccTurnPreparation, private readonly app: {
    serverUrl: string; localAuth: LocalAuthConfig;
  }, private readonly turns: Pick<TurnStateRepository, "findTurn">) {}

  async prepare(request: BtccTurnRequest): Promise<BtccPreparedTurn> {
    if (request.transport === "app" && request.route.role === "butler") {
      const existing = await this.turns.findTurn(request.turnId);
      if (existing?.semanticState === "delivered" || existing?.semanticState === "cancelled") {
        return this.preparation.prepare(request);
      }
      const context = request.appTurnContext;
      if (!context) throw new Error("app_session_context_required");
      const url = new URL("/internal/session-context-admission", this.app.serverUrl);
      url.searchParams.set("session_id", context.session.id);
      url.searchParams.set("turn_id", context.conversation.turnId);
      const headers: Record<string, string> = {};
      if (this.app.localAuth.required) {
        if (!this.app.localAuth.token) throw new Error("app_local_auth_unconfigured");
        headers.authorization = `Bearer ${this.app.localAuth.token}`;
      }
      const response = await fetch(url, { headers, signal: request.signal });
      if (!response.ok) throw new Error(`app_session_context_admission_${response.status}`);
      const acknowledgement = await response.json() as { data?: { admitted?: unknown } };
      if (acknowledgement.data?.admitted !== true) throw new Error("app_session_context_admission_invalid");
    }
    return this.preparation.prepare(request);
  }
}
