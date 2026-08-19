import type { Btcc } from "../../../agent/btcc/index.ts";
import type { SubsessionDelegationService } from "../../../agent/btcc/subsessions/index.ts";
import type {
  GatewayRoute,
  InboundEnvelope,
} from "../../../gateways/core/contracts.ts";

export type BtccGatewayHandlerOptions = {
  btcc: Btcc;
  generateSessionTitle?: (input: {
    envelope: InboundEnvelope;
    route: GatewayRoute;
  }) => Promise<string | null>;
  subsessionDelegation?: SubsessionDelegationService;
};
