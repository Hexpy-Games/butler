import { RollingSwap } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentStatusText } from "./CurrentStatusText";
import { useElapsedTime } from "./hooks/useElapsedTime";

export function CurrentModelRoundWaiting({ row, line }: { row: ProgressRow; line?: string }) {
  useAppLocale();
  const elapsed = useElapsedTime(row.created_at);
  const text = (
    <CurrentStatusText
      row={row}
      label={line ?? appCopy.interfaceStatus.generating}
      suffix={elapsed}
      testClass="turn-model-round-waiting"
      ariaLabel={appCopy.interfaceStatus.modelWaiting}
    />
  );
  return <RollingSwap itemKey={line ?? "generating"} motion={Boolean(line)}>{text}</RollingSwap>;
}
