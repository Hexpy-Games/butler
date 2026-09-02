import { Fragment, type ReactNode } from "react";
import type { MessageRecord, WorkerActivitySummary } from "@/app/types.ts";
import { MessageRow } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { SessionObserverWorkerRecord } from "./SessionObserverWorkerRecord.tsx";

export function SessionObserverTimeline({
  messages,
  workers,
  children,
}: {
  messages: MessageRecord[];
  workers: WorkerActivitySummary[];
  children?: ReactNode;
}) {
  const orderedMessages = [...messages].sort((left, right) =>
    left.created_at && right.created_at
      ? left.created_at.localeCompare(right.created_at)
      : 0,
  );
  const lastAssistantByTurn = new Map<string, string>();
  for (const message of orderedMessages) {
    if (message.role === "assistant" && message.turn_id) {
      lastAssistantByTurn.set(message.turn_id, message.id);
    }
  }
  const workersByMessage = new Map<string, WorkerActivitySummary[]>();
  const pendingWorkers: WorkerActivitySummary[] = [];
  for (const worker of workers) {
    if (worker.activity_kind === "planned") continue;
    const messageId = worker.parent_turn_id
      ? lastAssistantByTurn.get(worker.parent_turn_id)
      : undefined;
    if (messageId) {
      const group = workersByMessage.get(messageId) ?? [];
      group.push(worker);
      workersByMessage.set(messageId, group);
    } else {
      pendingWorkers.push(worker);
    }
  }

  return (
    <>
      {orderedMessages.map((message) => (
        <Fragment key={message.id}>
          <MessageRow
            role={message.role === "user" ? "user" : "assistant"}
            dataTestClass="steward-observer-message"
          >
            <MessageContent message={message} copied={false} footerMeta={null} />
          </MessageRow>
          {workersByMessage.get(message.id)?.map((worker) => (
            <SessionObserverWorkerRecord key={worker.worker_id} worker={worker} />
          ))}
        </Fragment>
      ))}
      {children}
      {pendingWorkers.map((worker) => (
        <SessionObserverWorkerRecord key={worker.worker_id} worker={worker} />
      ))}
    </>
  );
}
