import type { MessageRecord, WorkerActivitySummary } from "@/app/types.ts";
import { MessageRow } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { SessionObserverWorkerRecord } from "./SessionObserverWorkerRecord.tsx";

export function SessionObserverTimeline({
  messages,
  workers,
}: {
  messages: MessageRecord[];
  workers: WorkerActivitySummary[];
}) {
  const records = [
    ...messages.map((message, index) => ({
      kind: "message" as const,
      id: message.id,
      at: message.created_at,
      order: index,
      message,
    })),
    ...workers
      .filter((worker) => worker.activity_kind !== "planned")
      .map((worker, index) => ({
        kind: "worker" as const,
        id: worker.worker_id,
        at: worker.created_at ?? worker.updated_at,
        order: messages.length + index,
        worker,
      })),
  ].sort((left, right) =>
    left.at && right.at
      ? left.at.localeCompare(right.at) || left.order - right.order
      : left.order - right.order,
  );

  return records.map((record) => record.kind === "worker" ? (
    <SessionObserverWorkerRecord key={record.id} worker={record.worker} />
  ) : (
    <MessageRow
      key={record.id}
      role={record.message.role === "user" ? "user" : "assistant"}
      dataTestClass="steward-observer-message"
    >
      <MessageContent
        message={record.message}
        copied={false}
        footerMeta={null}
      />
    </MessageRow>
  ));
}
