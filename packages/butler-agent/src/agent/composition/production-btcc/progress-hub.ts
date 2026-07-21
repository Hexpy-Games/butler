import type { BtccTurnProgressObserver } from "../../btcc/index.ts";

export class BtccTurnProgressHub implements BtccTurnProgressObserver {
  private readonly observers = new Map<string, Set<BtccTurnProgressObserver>>();

  observe(turnId: string, observer: BtccTurnProgressObserver): () => void {
    const observers = this.observers.get(turnId) ?? new Set();
    observers.add(observer);
    this.observers.set(turnId, observers);
    return () => {
      observers.delete(observer);
      if (observers.size === 0) this.observers.delete(turnId);
    };
  }

  async stateChanged(
    update: Parameters<BtccTurnProgressObserver["stateChanged"]>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) => observer.stateChanged(update)));
  }
}
