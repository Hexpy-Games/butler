import { prepareElectronRun } from "./btcc-r3-electron/isolation-config.ts";
import { launchProduct, stopProduct } from "./btcc-r3-electron/product-launch.ts";
import { BTCC_R3_ELECTRON_SCENARIO_SCHEMA } from "./btcc-r3-electron/contracts.ts";

// Interactive public-client verification environment. No fixture provider, fake
// history, or pre-created execution binding: every conversation starts in UI.
const run = await prepareElectronRun({
  schema: BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
  id: "sidebar-organization-live", session: { kind: "chat", title: "사이드바 실제 검증" }, steps: [],
}, { repoRoot: process.cwd() });
const launch = await launchProduct(run, process.env.BUTLER_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api");
console.log(JSON.stringify({ runRoot: run.runRoot, dataRoot: run.dataRoot,
  debugPort: run.debugPort, serverPort: run.serverPort, model: run.model, pid: launch.child.pid }));
await new Promise<void>(resolve => {
  const stop = () => { void stopProduct(run, launch).finally(resolve); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
