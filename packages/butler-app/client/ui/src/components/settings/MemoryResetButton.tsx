import { Button, Spinner, Tooltip } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
export function MemoryResetButton({ running, locked, ready, empty, onClick, label = appCopy.settings.memory.reset }: {
  label?: string; running: boolean; locked: boolean; ready: boolean; empty: boolean; onClick: () => void;
}) {
  const copy = appCopy.settings.memory;
  const reason = locked ? copy.inUse : empty ? copy.nothingToReset : undefined;
  return <Tooltip label={reason}>
    <Button type="button" size="sm" variant="outline" aria-disabled={running || locked || !ready || empty}
      aria-label={reason ? `${label}. ${reason}` : label} aria-busy={running || undefined}
      iconStart={running ? <Spinner size={14} /> : undefined} onClick={onClick}>{label}</Button>
  </Tooltip>;
}
