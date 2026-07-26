import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import { ManagedHarnessModel } from "./managed-harness-model.ts";

type PhaseEnvelope = Parameters<BtccRuntimeDependencies["model"]["runRound"]>[0];

export class RestartingManagedHarnessModel extends ManagedHarnessModel {
  private readonly marker: string;

  constructor(
    dataRoot: string,
    private readonly activation: "automatic_provider_recovery" | "runtime_remediation" =
      "automatic_provider_recovery",
  ) {
    super(false);
    this.marker = join(dataRoot, `task-execution-${activation}-once`);
  }

  override runRound(envelope: PhaseEnvelope) {
    if (envelope.phase === "task_execution" && !existsSync(this.marker)) {
      writeFileSync(this.marker, "interrupted\n", "utf8");
      return Promise.resolve({
        kind: "interruption" as const,
        code: "simulated_provider_unavailable",
        activation: { kind: this.activation },
      });
    }
    return super.runRound(envelope);
  }
}
