import { mkdir, readdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Match the timeline's bounded still storage. Admission stops before input;
// unacknowledged pixels are never evicted to make room for another action.
const MAX_STEPS = 200;
const MAX_JPEG = 24 * 1024;
export function createStillOutbox(options) { return new StillOutbox(options); }

class StillOutbox {
  records = new Map();
  lane = Promise.resolve();
  sending = null;
  stopped = false;
  revision = 0;
  constructor({ directory, send, retryMs = [250, 1000, 4000] }) {
    this.directory = directory;
    this.send = send;
    this.retryMs = retryMs;
    this.ready = this.load();
  }
  path(id) { return join(this.directory, createHash("sha256").update(id).digest("hex") + ".json"); }
  exclusive(work) {
    const result = this.lane.then(work);
    this.lane = result.catch(() => {});
    return result;
  }
  async save(record) {
    const target = this.path(record.id), temporary = target + ".tmp";
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const record = JSON.parse(await readFile(join(this.directory, name), "utf8"));
      for (const entry of record.entries) entry.value ??= { reason: "pixels_not_captured" };
      this.records.set(record.id, record);
    }
  }
  async reserve(frame) {
    await this.ready;
    return this.exclusive(async () => {
      const count = frame.args.steps.length;
      const used = [...this.records.values()].reduce((n, row) => n + row.entries.length, 0);
      if (used + count > MAX_STEPS) throw Error("still_storage_full");
      const record = { id: frame.id, session: frame.session, tab: frame.tab,
        entries: Array.from({ length: count }, (_, step) => ({ step })) };
      await this.save(record);
      this.records.set(record.id, record);
    });
  }
  async deliver(id, value) {
    await this.ready;
    await this.exclusive(async () => {
      const record = this.records.get(id), entry = record?.entries.find(row => row.step === value.step);
      if (!entry) throw Error("still_reservation_missing");
      if (value.still && Buffer.from(value.still.base64, "base64").length > MAX_JPEG) throw Error("still_too_large");
      entry.value = value;
      await this.save(record);
      this.revision++;
    });
    void this.flush();
  }
  async finish(id, result) {
    await this.ready;
    await this.exclusive(async () => {
      const record = this.records.get(id);
      if (!record) return;
      const remaining = record.entries.filter(entry => entry.value || result.steps?.[entry.step]?.status === "completed" || result.steps?.[entry.step]?.reason === "dialog_pending");
      if (remaining.length === record.entries.length) return;
      record.entries = remaining;
      await this.persist(record);
    });
  }
  async persist(record) {
    if (record.entries.length) await this.save(record);
    else { await unlink(this.path(record.id)); this.records.delete(record.id); }
  }
  async attempt(record, entry) {
    for (let index = 0; index <= this.retryMs.length && !this.stopped; index++) {
      try {
        await this.send({ act_id: record.id, session: record.session, tab: record.tab, step: entry.step, ...entry.value });
        await this.exclusive(async () => {
          record.entries = record.entries.filter(row => row !== entry);
          await this.persist(record);
        });
        return;
      } catch {
        if (index < this.retryMs.length) await new Promise(done => {
          this.wake = done;
          this.timer = setTimeout(done, this.retryMs[index]);
        });
      }
    }
  }
  async flush() {
    await this.ready;
    if (this.sending) return this.sending;
    this.sending = this.sendQueue().finally(() => { this.sending = null; });
    return this.sending;
  }
  async sendQueue() {
    let revision;
    do {
      await this.lane;
      revision = this.revision;
      for (const record of [...this.records.values()]) {
        for (const entry of [...record.entries]) if (entry.value) await this.attempt(record, entry);
      }
    } while (!this.stopped && revision !== this.revision);
  }
  async connect() { this.stopped = false; await this.flush(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.wake?.(); }
}
