import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "packages", "butler-agent", "src");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("production App and Agent composition expose no opposite-store opener", () => {
  const appSources = [
    "gateways/app/application/kernel/app-store-kernel-initializer.ts",
    "gateways/app/application/kernel/app-store-kernel-state.ts",
    "gateways/app/infrastructure/transport/transport-module-graph.ts",
    "gateways/app/infrastructure/transport/transport-queue-store.ts",
  ].map(source).join("\n");
  expect(appSources).not.toContain("SessionBindingStore");
  expect(appSources).not.toContain("AgentConversationStore");
  expect(appSources).not.toContain("appMessageDbPath");

  const agentSources = [
    "application/native-butler.ts",
    "application/native-steward.ts",
    "agent/composition/create-btcc-composition.ts",
    "agent/btcc/agent-loop/guided-turn-agent.ts",
    "agent/btcc/agent-loop/guided-persistent-effect-resolution.ts",
  ].map(source).join("\n");
  expect(agentSources).not.toContain("appMessageDbPath");
  expect(agentSources).not.toContain("appTurnStateDbPath");
  expect(agentSources).not.toContain("AppBtccStopConsumer");
  expect(agentSources).not.toContain("resolveAppGatewayRuntimeConfig");
});

test("Native Butler runtime identity exposes no App database resolver", () => {
  const identity = source("interfaces/gateway/native-butler/runtime-identity.ts");
  const exports = source("interfaces/gateway/native-butler/index.ts");
  expect(identity).not.toContain("butler-client.sqlite");
  expect(identity).not.toContain("resolveAppGatewayRuntimeConfig");
  expect(exports).not.toContain("appTurnStateDbPath");
});

test("Native Steward is queue-only and cannot compose or deliver BTCC directly", () => {
  const steward = source("application/native-steward.ts");
  expect(steward).toContain("NativeInboundQueue");
  expect(steward).not.toContain("createProductionBtccComposition");
  expect(steward).not.toContain("createBtccGatewayHandlers");
  expect(steward).not.toContain("DeliveryGuard");
  expect(steward).not.toContain("SessionBindingStore");
});

test("App projection has no historical BTCC SQL reconciliation authority", () => {
  const projection = source(
    "gateways/app/infrastructure/transport/transport-projection-store.ts",
  );
  const graph = source(
    "gateways/app/infrastructure/transport/transport-module-graph.ts",
  );
  expect(projection).not.toContain("AppTransportHistoricalReconciliationStore");
  expect(graph).not.toContain("AppTransportHistoricalReconciliationOwner");
  expect(graph).not.toContain("terminalSettlementWakeOwner");
});
