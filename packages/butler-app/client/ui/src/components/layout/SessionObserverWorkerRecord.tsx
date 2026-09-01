import type { WorkerActivitySummary } from "@/app/types.ts";
import { workerActivityDisplayName } from "@/app/utils.ts";
import { MessageRow, Stack, Tag } from "@/butler-ds";

export function SessionObserverWorkerRecord({
  worker,
}: {
  worker: WorkerActivitySummary;
}) {
  const name = workerActivityDisplayName(worker);
  return (
    <MessageRow
      role="assistant"
      dataTestClass="steward-observer-worker-message"
    >
      <Stack
        align="row"
        gap="xs"
        wrap
        aria-label={`Worker ${name}`}
        data-test-class="steward-observer-worker-capsules"
      >
        <Tag ariaLabel={`Worker ${name}`}>{name}</Tag>
      </Stack>
    </MessageRow>
  );
}
