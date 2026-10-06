import { readFile, writeFile } from "node:fs/promises";
import type { TaskMetrics } from "./contracts.ts";
import { runPerception } from "../smoke/browser-perception-smoke.ts";
import { RawA11yProvider } from "./raw-a11y-provider.ts";

export interface Suite { id: string; layer: string; tasks: { id: string; source: string }[] }
export interface TaskExecutor { run(task: Suite["tasks"][number], arm: string, run: number): Promise<TaskMetrics> }

/** Stub/replay executor comes later; never silently issue live calls. */
export async function runSuite(suite: Suite, arm: string, executor: TaskExecutor, output: string) {
  const results: TaskMetrics[] = [];
  for (const task of suite.tasks) for (let run = 1; run <= 3; run++) results.push(await executor.run(task, arm, run));
  const pass3 = suite.tasks.filter((task) => results.filter((r) => r.task === task.id).every((r) => r.success)).length / suite.tasks.length;
  const report = { schema: "butler.browser-eval.tasks.v1", suite: suite.id, arm, results, summary: {
    successMean: results.filter((r) => r.success).length / results.length, pass3,
    bootstrapCI: null, bootstrapStatus: "not implemented; do not interpret as CI-qualified",
  } };
  await writeFile(output, JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  const [suite = "fixtures", arm = "A0"] = process.argv.slice(2);
  const data = JSON.parse(await readFile(new URL(`./suites/${suite}.json`, import.meta.url), "utf8")) as Suite;
  if (!process.env.BUTLER_BROWSER_EVAL_OUTPUT) throw new Error("Set BUTLER_BROWSER_EVAL_OUTPUT");
  if (data.id !== "fixtures" || arm !== "A0") throw new Error("Only fixtures/A0 L1 is implemented. L2–L4 require an explicit stub/replay executor; live calls are disabled.");
  await runPerception(new RawA11yProvider(), process.env.BUTLER_BROWSER_EVAL_OUTPUT);
}
