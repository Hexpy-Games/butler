import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";

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
    this.input.syncAll();
    this.watcher = watch(join(transcriptRoot, "*.jsonl"), {
      ignoreInitial: true,
    });
    this.watcher.on("add", () => this.schedule());
    this.watcher.on("change", () => this.schedule());
    this.watcher.on("unlink", () => this.schedule());
    this.watcher.on("ready", () => this.schedule());
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) void watcher.close();
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (!this.closed) this.input.syncAll();
    }, PROJECTION_SETTLE_MS);
  }
}
