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

  async openingDecisionAccepted(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["openingDecisionAccepted"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.openingDecisionAccepted?.(update),
    ));
  }

  async workProgressChanged(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["workProgressChanged"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.workProgressChanged?.(update),
    ));
  }

  async phaseActivityChanged(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["phaseActivityChanged"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.phaseActivityChanged?.(update),
    ));
  }

  async modelRoundWaiting(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["modelRoundWaiting"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.modelRoundWaiting?.(update),
    ));
  }

  async operationChanged(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["operationChanged"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.operationChanged?.(update),
    ));
  }

  async operationalNoticeChanged(
    update: Parameters<NonNullable<
      BtccTurnProgressObserver["operationalNoticeChanged"]
    >>[0],
  ): Promise<void> {
    const observers = [...(this.observers.get(update.turnId) ?? [])];
    await Promise.all(observers.map((observer) =>
      observer.operationalNoticeChanged?.(update),
    ));
  }
}
