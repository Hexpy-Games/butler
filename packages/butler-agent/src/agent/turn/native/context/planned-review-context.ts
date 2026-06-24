import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";

export interface PlannedReviewTurnContext {
  taskId: string;
  attempt: number | null;
  workerTaskId: string | null;
  reviewEventId: string | null;
}

function plannedReviewTaskIdFromText(text: string): string | null {
  const fromReviewId = text.match(/planned-review:(planned-[A-Za-z0-9._-]+)/u)?.[1];
  if (fromReviewId) return fromReviewId;
  return text.match(/Planned task ID:\s*(planned-[A-Za-z0-9._-]+)/iu)?.[1] ?? null;
}

function plannedReviewAttemptFromText(text: string): number | null {
  const fromEvent = text.match(/system:planned-review:[^:\s]+:attempt-(\d+)/u)?.[1];
  const fromLine = fromEvent ?? text.match(/Attempt:\s*(\d+)/iu)?.[1];
  if (!fromLine) return null;
  const parsed = Number.parseInt(fromLine, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function plannedReviewWorkerTaskIdFromText(text: string): string | null {
  return text.match(/Worker task ID:\s*([A-Za-z0-9._:-]+)/iu)?.[1] ?? null;
}

function plannedReviewEventIdFromText(text: string): string | null {
  const fromEvent = text.match(
    /system:planned-review:[^:\s]+:attempt-\d+:([A-Za-z0-9._:-]+)/u,
  )?.[1];
  return fromEvent ?? text.match(/Review event ID:\s*([A-Za-z0-9._:-]+)/iu)?.[1] ?? null;
}

export function plannedReviewTurnContext(input: RuntimeTurnInput): PlannedReviewTurnContext | null {
  if ("text" in input.input) return null;
  const envelope = input.input;
  const candidates = [
    envelope.eventId,
    envelope.message.id,
    envelope.message.text ?? "",
  ];
  for (const candidate of candidates) {
    const taskId = plannedReviewTaskIdFromText(candidate);
    if (taskId) {
      const joined = candidates.join("\n");
      return {
        taskId,
        attempt: plannedReviewAttemptFromText(joined),
        workerTaskId: plannedReviewWorkerTaskIdFromText(joined),
        reviewEventId: plannedReviewEventIdFromText(joined),
      };
    }
  }
  return null;
}
