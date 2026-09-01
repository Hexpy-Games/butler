import type { MessageRecord, WorkerActivitySummary } from "@/app/types.ts";
import { workerActivityDisplayName } from "@/app/utils.ts";
import { MessageRow, Stack, Tag } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";

export function SessionObserverTimeline({
  messages,
  workers,
}: {
  messages: MessageRecord[];
  workers: WorkerActivitySummary[];
}) {
  let workerAnchor = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      workerAnchor = index;
      break;
    }
  }
  const workerNames = [...new Set(
    workers
      .filter((worker) => worker.activity_kind !== "planned")
      .map(workerActivityDisplayName),
  )];

  return messages.map((message, index) => (
    <MessageRow
      key={message.id}
      role={message.role === "user" ? "user" : "assistant"}
      dataTestClass="steward-observer-message"
    >
      <MessageContent message={message} copied={false} footerMeta={null} />
      {index === workerAnchor && workerNames.length > 0 ? (
        <Stack
          align="row"
          gap="xs"
          wrap
          data-test-class="steward-observer-worker-capsules"
        >
          {workerNames.map((name) => (
            <Tag key={name} ariaLabel={`Worker ${name}`}>{name}</Tag>
          ))}
        </Stack>
      ) : null}
    </MessageRow>
  ));
}
