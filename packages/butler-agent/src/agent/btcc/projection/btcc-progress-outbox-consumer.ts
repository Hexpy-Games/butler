import type {
  BtccProgressEventRepository,
  BtccProgressProjectionHost,
  BtccTurnProgressPublisher,
} from "../contracts.ts";

/**
 * Delivers committed progress facts independently of Turn execution.
 *
 * A failed publisher leaves the durable event pending.  Reconcile is safe to
 * call from startup and every normal host poll because event identity and
 * sequence are owned by the repository, not by this consumer.
 */
export function createBtccProgressProjectionHost(
  repository: BtccProgressEventRepository,
): BtccProgressProjectionHost {
  let running: Promise<{
    attempted: number;
    published: number;
    pending: number;
  }> | null = null;

  return {
    hasCommittedEvent(turnId: string, kind: string): boolean {
      return repository.forTurn(turnId).some((event) => event.event.kind === kind);
    },
    reconcile(publisher: BtccTurnProgressPublisher) {
      if (running) return running;
      running = reconcile(repository, publisher).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

async function reconcile(
  repository: BtccProgressEventRepository,
  publisher: BtccTurnProgressPublisher,
): Promise<{
  attempted: number;
  published: number;
  pending: number;
}> {
  const pending = repository.pending();
  let published = 0;
  for (const event of pending) {
    try {
      await publisher.publish(event);
      repository.markPublished(event.eventId);
      published += 1;
    } catch {
      // Projection failure must not veto Turn state or prevent later events
      // from being retried by the next host poll.
    }
  }
  return {
    attempted: pending.length,
    published,
    pending: repository.pending().length,
  };
}
