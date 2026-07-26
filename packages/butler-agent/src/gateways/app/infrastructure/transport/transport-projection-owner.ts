import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const PROJECTION_SETTLE_MS = 25;

export class AppTransportProjectionOwner {
  private watcher: FSWatcher | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly input: {
      butlerData: string;
      syncAll: () => number;
    },
  ) {}

  start(): void {
    if (this.watcher || this.closed) return;
    const transcriptRoot = join(this.input.butlerData, "transcripts");
    mkdirSync(transcriptRoot, { recursive: true });
    this.watcher = watch(transcriptRoot, { persistent: false }, (_event, file) => {
      if (!file || String(file).endsWith(".jsonl")) this.schedule();
    });
    try {
      this.input.syncAll();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    const watcher = this.watcher;
    this.watcher = null;
    watcher?.close();
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (!this.closed) this.input.syncAll();
    }, PROJECTION_SETTLE_MS);
  }
}
