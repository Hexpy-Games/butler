import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentStatusText } from "./CurrentStatusText";
import { useElapsedTime } from "./hooks/useElapsedTime";

export function CurrentModelRoundWaiting({ row }: { row: ProgressRow }) {
  useAppLocale();
  const elapsed = useElapsedTime(row.created_at);
  return (
    <CurrentStatusText
      row={row}
      label={appCopy.interfaceStatus.generating}
      suffix={elapsed}
      testClass="turn-model-round-waiting"
      ariaLabel={appCopy.interfaceStatus.modelWaiting}
    />
  );
}
