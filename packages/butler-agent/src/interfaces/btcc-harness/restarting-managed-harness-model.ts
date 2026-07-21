import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import { ManagedHarnessModel } from "./managed-harness-model.ts";

type PhaseEnvelope = Parameters<BtccRuntimeDependencies["model"]["runRound"]>[0];

export class RestartingManagedHarnessModel extends ManagedHarnessModel {
  private readonly marker: string;

  constructor(dataRoot: string) {
    super(false);
    this.marker = join(dataRoot, "task-execution-interrupted-once");
  }

  override runRound(envelope: PhaseEnvelope) {
    if (envelope.phase === "task_execution" && !existsSync(this.marker)) {
      writeFileSync(this.marker, "interrupted\n", "utf8");
      throw new Error("simulated process interruption before Task Execution");
    }
    return super.runRound(envelope);
  }
}
