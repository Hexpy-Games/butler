import { createHash } from "node:crypto";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";

type ObservationExecutor = BtccRuntimeDependencies["operations"];
type PerformInput = Parameters<ObservationExecutor["perform"]>[0];
type OperationResult = Awaited<ReturnType<ObservationExecutor["perform"]>>;

export class HarnessObservationExecutor implements ObservationExecutor {
  callCount = 0;

  async perform({ request }: PerformInput): Promise<OperationResult> {
    this.callCount += 1;
    const content = observationFor(request.capabilityRef);
    return {
      requestId: request.requestId,
      outcome: "observed",
      observationRef: {
        id: digest(`btcc-harness-observation.v1\0${request.requestId}\0${content}`),
        sha256: digest(content),
      },
      content,
    };
  }
}

function observationFor(capabilityRef: string): string {
  switch (capabilityRef) {
    case "weather:seoul-current":
      return "서울은 현재 맑고 24도입니다.";
    case "meme:current-first":
      return "현재 밈 관찰 1: 월요일을 버티는 직장인 고양이";
    case "meme:current-second":
      return "현재 밈 관찰 2: 예상과 현실을 비교하는 두 장면 형식";
    default:
      throw new Error(`Unknown harness observation capability: ${capabilityRef}`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
