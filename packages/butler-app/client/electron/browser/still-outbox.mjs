import { mkdir, readdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { syncDirectory } from "../butler-platform/durable-directory.mjs";

// Admission stops before input; unacknowledged pixels are never evicted.
const MAX_STEPS = 200;
const MAX_JPEG = 24 * 1024;
const MAX_CORRUPT = 8;
export function createStillOutbox(options) { return new StillOutbox(options); }

class StillOutbox {
  records = new Map();
  lane = Promise.resolve();
  sending = null;
  stopped = false;
  revision = 0;
  replays = [];
  constructor({ directory, send, retryMs = [250, 1000, 4000], replayDirectories = [], onChanged = () => {} }) {
    Object.assign(this, { directory, send, retryMs, replayDirectories, onChanged });
    this.ready = this.load();
  }
  get pending() { return [...this.records.values()].reduce((n, row) => n + row.entries.length, 0) + this.replays.reduce((n, queue) => n + queue.pending, 0); }
  path(id) { return join(this.directory, createHash("sha256").update(id).digest("hex") + ".json"); }
  exclusive(work) {
    const result = this.lane.then(work);
    this.lane = result.catch(() => {});
    return result;
  }
  async save(record) {
    // Input waits for both syncs, so they run together. A reservation torn
    // before its syncs ended never preceded input; load quarantines it.
    const file = await open(this.path(record.id), "w", 0o600);
    try { await file.writeFile(JSON.stringify(record) + "\n"); await Promise.all([file.sync(), syncDirectory(this.directory)]); }
    finally { await file.close(); }
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let quarantined = 0;
    for (const name of (await readdir(this.directory)).sort()) {
      const path = join(this.directory, name);
      if (/^[a-f0-9]{64}\.json\.tmp$/u.test(name)) { await unlink(path); continue; }
      if (name.endsWith(".corrupt")) { if (++quarantined > MAX_CORRUPT) await unlink(path); continue; }
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      try { await this.loadRecord(path); }
      catch {
        if (quarantined++ < MAX_CORRUPT) await rename(path, path + ".corrupt");
        else await unlink(path);
        console.error("[browser] quarantined unreadable still record");
      }
    }
    await syncDirectory(this.directory);
    this.onChanged();
  }
  async loadRecord(path) {
    const text = await readFile(path, "utf8"), lines = text.split("\n");
    const record = JSON.parse(lines.shift());
    if (typeof record.id !== "string" || !Array.isArray(record.entries)) throw Error("invalid_record");
    // Old single-JSON records remain readable. A torn last append cannot erase prior pixels.
    let length = Buffer.byteLength(text.split("\n")[0]) + 1;
    for (const [index, line] of lines.entries()) {
      if (!line) { length++; continue; }
      let value;
      try { value = JSON.parse(line); }
      catch (error) {
        if (index !== lines.length - 1) throw error;
        const file = await open(path, "r+");
        try { await file.truncate(length); await file.sync(); } finally { await file.close(); }
        break;
      }
      const entry = record.entries.find(entry => entry.step === value.step);
      if (entry) entry.value = value;
      length += Buffer.byteLength(line) + 1;
    }
    for (const entry of record.entries) entry.value ??= { reason: "pixels_not_captured" };
    record.capacity ??= record.entries.length;
    this.records.set(record.id, record);
  }
  async reserve(frame) {
    await this.ready;
    return this.exclusive(async () => {
      const count = frame.args.steps.length;
      const used = [...this.records.values()].reduce((n, record) => n + record.capacity, 0);
      if (used + count > MAX_STEPS) throw Error("still_storage_full");
      const record = { id: frame.id, session: frame.session, tab: frame.tab, capacity: count,
        entries: Array.from({ length: count }, (_, step) => ({ step })) };
      await this.save(record);
      this.records.set(record.id, record);
      this.onChanged();
    });
  }
  async append(record, values) {
    const file = await open(this.path(record.id), "a", 0o600);
    // Only the new steps are written and synced, never the earlier JPEGs.
    try { await file.writeFile(values.map(value => "\n" + JSON.stringify(value) + "\n").join("")); await file.sync(); }
    finally { await file.close(); }
  }
  async deliver(id, value) {
    await this.ready;
    await this.exclusive(async () => {
      const record = this.records.get(id), entry = record?.entries.find(row => row.step === value.step);
      if (!entry) throw Error("still_reservation_missing");
      if (value.still && Buffer.from(value.still.base64, "base64").length > MAX_JPEG) throw Error("still_too_large");
      await this.append(record, [value]);
      entry.value = value;
      this.revision++;
    });
    void this.flush();
  }
  async finish(id, result) {
    await this.ready;
    await this.exclusive(async () => {
      const record = this.records.get(id);
      if (!record) return;
      const settled = record.entries.flatMap(entry => {
        const step = result.steps?.[entry.step];
        if (entry.value || step?.status === "completed" || step?.reason === "dialog_pending") return [];
        return [[entry, { step: entry.step, reason: step?.reason ?? result.reason ?? "pixels_not_captured" }]];
      });
      if (!settled.length) return;
      // One sync covers every never-run step of this act.
      await this.append(record, settled.map(([, value]) => value));
      for (const [entry, value] of settled) entry.value = value;
      this.revision++;
    });
    void this.flush();
  }
  async acknowledge(record, entry) {
    await this.exclusive(async () => {
      // Partial acknowledgements need no rewrite: replay is idempotent at the gateway.
      const remaining = record.entries.filter(row => row !== entry);
      if (!remaining.length) {
        await unlink(this.path(record.id));
        await syncDirectory(this.directory);
        this.records.delete(record.id);
      }
      record.entries = remaining;
      this.onChanged();
    });
  }
  async attempt(record, entry) {
    try {
      await this.send({ act_id: record.id, session: record.session, tab: record.tab, step: entry.step, ...entry.value });
    } catch (error) {
      if (!Number.isInteger(error.status) || error.status >= 500) {
        const attempt = entry.attempts ?? 0;
        entry.attempts = attempt + 1;
        entry.retryAt = this.retryMs.length ? Date.now() + this.retryMs[Math.min(attempt, this.retryMs.length - 1)] : Infinity;
        return;
      }
      console.error(`[browser] still rejected: HTTP ${error.status} ${error.message}`);
    }
    await this.acknowledge(record, entry);
  }
  async flush() {
    await this.ready;
    if (this.sending) return this.sending;
    this.sending = this.sendQueue().finally(() => { this.sending = null; this.schedule(); });
    return this.sending;
  }
  async sendQueue() {
    let revision;
    do {
      await this.lane;
      revision = this.revision;
      for (const record of [...this.records.values()]) {
        for (const entry of [...record.entries]) {
          if (this.stopped) return;
          if (entry.value && !(entry.retryAt > Date.now())) await this.attempt(record, entry);
        }
      }
    } while (!this.stopped && revision !== this.revision);
    await Promise.all(this.replays.map(queue => queue.flush()));
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const next = Math.min(...[...this.records.values()].flatMap(record => record.entries.filter(entry => entry.value).map(entry => entry.retryAt ?? Infinity)));
    if (Number.isFinite(next)) this.timer = setTimeout(() => { void this.flush(); }, Math.max(0, next - Date.now()));
  }
  async connect() {
    this.stopped = false;
    await this.ready;
    for (const record of this.records.values()) for (const entry of record.entries) { delete entry.retryAt; delete entry.attempts; }
    for (const queue of this.replays) queue.stop();
    this.replays = this.replayDirectories.map(directory => createStillOutbox({ directory, send: this.send, retryMs: this.retryMs, onChanged: this.onChanged }));
    await Promise.all(this.replays.map(queue => queue.ready));
    await this.flush();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); for (const queue of this.replays) queue.stop(); }
}
