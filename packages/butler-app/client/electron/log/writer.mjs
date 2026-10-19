import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createRedactor } from "./redaction.mjs";

const MB = 1024 * 1024;
const SEVERITY = { ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5 };
const THRESHOLD = { minimal: 2, standard: 3, detailed: 4, full: 5 };
const ROTATE = 16 * MB;
async function loadSecrets(root, redactor) {
  if (!root) return;
  for (const name of ["local-agent-auth.json", "local-admin.json"]) {
    try { redactor.observe(JSON.parse(await readFile(join(root, "app/runtime/auth", name), "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Single App main process owns both lanes. Timers exist only while records are queued. */
export function createAppLogWriter(dataRoot) { return new AppLogWriter(dataRoot); }
class AppLogWriter {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.redactor = createRedactor();
    this.config = { level: "standard", category_levels: {} };
    this.queue = []; this.queuedBytes = 0; this.stopped = false;
    this.lanes = new Map(); this.failure = null; this.secretsReady = false;
    this.pending = loadSecrets(dataRoot, this.redactor).then(() => { this.secretsReady = true; })
      .catch(error => { this.failure = error.code ?? "log_credentials_unavailable"; });
  }
  remember(value) { this.redactor.remember(value); }
  observe(value) { this.redactor.observe(value); }
  enabled(category, level) {
    let threshold = THRESHOLD[this.config.level] ?? 3;
    for (const key of Object.keys(this.config.category_levels ?? {}).sort((a, b) => a.length - b.length)) {
      if (category === key || category.startsWith(`${key}.`)) threshold = SEVERITY[this.config.category_levels[key]];
    }
    if (level === "TRACE" && this.config.level !== "full") return false;
    return SEVERITY[level] > 0 && SEVERITY[level] <= threshold;
  }
  async segment(lane) {
    let entry = this.lanes.get(lane);
    if (entry) return entry;
    const dir = join(this.dataRoot, "logs", "app", lane);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const prefix = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    for (let sequence = 1; ; sequence++) {
      const path = join(dir, `${prefix}-${String(sequence).padStart(4, "0")}.jsonl`);
      try {
        entry = { file: await open(path, "wx", 0o600), path, bytes: 0 };
        this.lanes.set(lane, entry); return entry;
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  }
  async close(lane) {
    const entry = this.lanes.get(lane);
    if (!entry) return;
    this.lanes.delete(lane);
    try { await entry.file.sync(); } finally { await entry.file.close(); }
  }
  async prune(lane) {
    const dir = join(this.dataRoot, "logs", "app", lane);
    const names = await readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const files = [];
    for (const name of names.filter(name => name.endsWith(".jsonl")).sort()) {
      const path = join(dir, name);
      try { files.push({ path, ...await stat(path) }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const cap = lane === "main" ? 64 * MB : 256 * MB;
    const age = (lane === "main" ? 14 * 24 : 72) * 3600_000;
    for (const file of files) {
      if (file.path === this.lanes.get(lane)?.path || total <= cap && Date.now() - file.mtimeMs <= age) continue;
      await unlink(file.path).catch(error => { if (error.code !== "ENOENT") throw error; });
      await unlink(file.path.replace(/\.jsonl$/u, ".idx")).catch(error => { if (error.code !== "ENOENT") throw error; });
      total -= file.size;
    }
  }
  async writeBatch(batch) {
    if (!this.secretsReady) return;
    for (const lane of ["main", "debug"]) {
      const records = batch.filter(row => (SEVERITY[row.level] <= 3 ? "main" : "debug") === lane && this.enabled(row.category, row.level));
      if (!records.length) continue;
      const active = this.lanes.get(lane);
      if (active && !await stat(active.path).catch(error => { if (error.code === "ENOENT") return null; throw error; })) await this.close(lane);
      let entry = await this.segment(lane);
      let lines = [], sync = false;
      for (const row of records) {
        const line = JSON.stringify(this.redactor.redact(row)) + "\n";
        const length = Buffer.byteLength(line);
        if (entry.bytes + length > ROTATE) {
          if (lines.length) await entry.file.writeFile(lines.join(""));
          await this.close(lane); lines = [];
          entry = await this.segment(lane);
        }
        lines.push(line); sync ||= row.level === "ERROR";
        entry.bytes += length;
      }
      if (lines.length) {
        const entry = this.lanes.get(lane);
        await entry.file.writeFile(lines.join(""));
        if (sync) await entry.file.sync();
        await this.prune(lane);
      }
    }
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.queue; this.queue = []; this.queuedBytes = 0;
    if (batch.length) this.pending = this.pending.then(() => this.writeBatch(batch)).catch(error => { this.failure = error.code ?? "log_write_failed"; });
    return this.pending;
  }
  record(input, process = "app.main") {
    if (!this.dataRoot || this.stopped || !this.enabled(input.category, input.level)) return;
    const row = { ts: new Date().toISOString().replace(/(\.\d{3})Z$/u, "$1000Z"), attrs: {}, ...input, process };
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > MB || SEVERITY[row.level] >= 4 && this.queuedBytes + size > 16 * MB) return;
    this.queue.push(row); this.queuedBytes += size;
    this.timer ??= setTimeout(() => this.flush(), 100).unref();
    if (row.level === "ERROR" || this.queuedBytes >= MB) void this.flush();
  }
  configure(view) {
    if (!view?.effective || !THRESHOLD[view.effective.level]) return;
    const verbose = ["detailed", "full"].includes(view.effective.level);
    this.config = view.effective;
    if (!verbose) this.pending = this.pending.then(() => this.close("debug")).catch(error => { this.failure = error.code; });
  }
  async quit(timeout = 1000) {
    this.record({ level: "INFO", category: "lifecycle", event: "app.quit", msg: "App quit" });
    this.stopped = true;
    const drain = this.flush().then(() => Promise.all([...this.lanes.keys()].map(lane => this.close(lane))));
    let deadline;
    try { await Promise.race([drain, new Promise(resolve => { deadline = setTimeout(resolve, timeout); })]); }
    catch (error) { this.failure = error.code ?? "log_close_failed"; }
    finally { clearTimeout(deadline); }
  }
}
