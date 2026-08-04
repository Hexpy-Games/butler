export class FakeClock {
  private now = Date.now();
  private nextTimerId = 1;
  private readonly timers = new Map<number, {
    callback: () => void;
    dueAt: number;
  }>();
  private originalSetTimeout?: typeof setTimeout;
  private originalClearTimeout?: typeof clearTimeout;
  private originalDateNow?: typeof Date.now;

  install(): void {
    this.originalSetTimeout = globalThis.setTimeout;
    this.originalClearTimeout = globalThis.clearTimeout;
    this.originalDateNow = Date.now;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (typeof callback !== "function") {
        throw new TypeError("FakeClock only supports function callbacks.");
      }
      const id = this.nextTimerId++;
      const delayMs = Number.isFinite(Number(delay))
        ? Math.max(0, Number(delay))
        : 0;
      this.timers.set(id, {
        callback: callback as () => void,
        dueAt: this.now + delayMs,
      });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      this.timers.delete(Number(id));
    }) as unknown as typeof clearTimeout;
    Date.now = () => this.now;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort(([, left], [, right]) => left.dueAt - right.dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.dueAt;
      timer.callback();
      await flushMicrotasks();
    }
    this.now = target;
    await flushMicrotasks();
  }

  uninstall(): void {
    this.timers.clear();
    if (this.originalSetTimeout) globalThis.setTimeout = this.originalSetTimeout;
    if (this.originalClearTimeout) {
      globalThis.clearTimeout = this.originalClearTimeout;
    }
    if (this.originalDateNow) Date.now = this.originalDateNow;
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}
