import { Button, Spinner, Tooltip } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
export function MemoryResetButton({ running, locked, ready, empty, onClick }: {
  running: boolean; locked: boolean; ready: boolean; empty: boolean; onClick: () => void;
}) {
  const copy = appCopy.settings.memory;
  const reason = locked ? copy.inUse : empty ? copy.nothingToReset : undefined;
  return <Tooltip label={reason}>
    <Button type="button" size="sm" variant="outline" aria-disabled={running || locked || !ready || empty}
      aria-label={reason ? `${copy.reset}. ${reason}` : copy.reset} aria-busy={running || undefined}
      iconStart={running ? <Spinner size={14} /> : undefined} onClick={onClick}>{copy.reset}</Button>
  </Tooltip>;
}
