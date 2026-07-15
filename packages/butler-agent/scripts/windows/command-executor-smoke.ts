import { runCommandExecutorConformance } from "../../src/runtime/command/conformance.ts";
import { createPlatformCommandExecutor } from "../../src/runtime/command/platform-command-executor.ts";

if (process.platform !== "win32") {
  throw new Error("Windows command executor smoke requires win32");
}

const executor = createPlatformCommandExecutor();
const conformance = await runCommandExecutorConformance(executor, process.execPath);

console.log(JSON.stringify({
  ok: true,
  platform: process.platform,
  conformance,
  rawScriptAccepted: false,
  rawTextIncluded: false,
}));
