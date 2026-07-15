export function drainAppForegroundActiveWork(input: {
  snapshot: {
    classification?: string;
    turn_ids?: string[];
    worker_ids?: string[];
  };
  cancelTurn: (turnId: string) => Promise<unknown>;
  cancelWorker: (workerId: string) => Promise<unknown>;
  readSnapshot: () => Promise<{ classification?: string }>;
  attempts?: number;
  delayMs?: number;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>>;
