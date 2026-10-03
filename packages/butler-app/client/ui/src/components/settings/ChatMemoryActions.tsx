import { Button, Spinner, Tooltip } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
export function ChatMemoryActions({ busy, locked, ready, reclaimable, start }: {
  busy: boolean; locked?: boolean; ready: boolean; reclaimable?: number | null; start: () => void;
}) {
  const copy = appCopy.settings.memory;
  const reason = locked ? copy.inUse : reclaimable === 0 ? copy.nothingToFree : undefined;
  return <Tooltip label={reason}>
    <Button type="button" size="sm" variant="outline" disabled={busy || locked || !ready || reclaimable === 0}
      aria-label={reason ? `${copy.freeSpace}. ${reason}` : copy.freeSpace} aria-busy={busy || undefined}
      iconStart={busy ? <Spinner size={14} /> : undefined} onClick={start}>{copy.freeSpace}</Button>
  </Tooltip>;
}
