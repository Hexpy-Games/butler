import type { ProgressRow } from "@/app/types.ts";
import { CurrentStatusText } from "./CurrentStatusText";
import { useElapsedTime } from "./hooks/useElapsedTime";

export function CurrentModelRoundWaiting({ row }: { row: ProgressRow }) {
  const elapsed = useElapsedTime(row.created_at);
  return (
    <CurrentStatusText
      row={row}
      label="응답 생성 중"
      suffix={elapsed}
      testClass="turn-model-round-waiting"
      ariaLabel="모델 응답 대기"
    />
  );
}
