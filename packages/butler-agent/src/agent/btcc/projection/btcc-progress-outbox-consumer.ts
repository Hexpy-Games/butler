import type {
  BtccCommittedProgressEvent,
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
  let publisher: BtccTurnProgressPublisher | null = null;
  let deliveryTail: Promise<void> = Promise.resolve();

  function enqueue<T>(delivery: () => Promise<T>): Promise<T> {
    const next = deliveryTail.then(delivery, delivery);
    deliveryTail = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    hasCommittedEvent(turnId: string, kind: string): boolean {
      return repository.forTurn(turnId).some((event) => event.event.kind === kind);
    },
    connect(nextPublisher: BtccTurnProgressPublisher): void {
      publisher = nextPublisher;
    },
    publishCommitted(event: BtccCommittedProgressEvent) {
      if (!publisher) return Promise.resolve();
      return enqueue(async () => {
        const pending = repository.pending(event.turnId).find(
          (candidate) => candidate.eventId === event.eventId,
        );
        if (!pending || !publisher) return;
        await publish(repository, publisher, pending);
      });
    },
    reconcile(nextPublisher: BtccTurnProgressPublisher) {
      publisher = nextPublisher;
      return enqueue(() => reconcile(repository, nextPublisher));
    },
  };
}

async function publish(
  repository: BtccProgressEventRepository,
  publisher: BtccTurnProgressPublisher,
  event: BtccCommittedProgressEvent,
): Promise<boolean> {
  try {
    await publisher.publish(event);
    repository.markPublished(event.eventId);
    return true;
  } catch {
    // The durable event remains pending for the normal reconciliation poll.
    return false;
  }
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
    if (await publish(repository, publisher, event)) {
      published += 1;
    }
  }
  return {
    attempted: pending.length,
    published,
    pending: repository.pending().length,
  };
}
