import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { browserEvent } from "./events.mjs";

export const FILE_LIMIT = 100_000_000;
export const SESSION_LIMIT = 500_000_000;
const HISTORY_LIMIT = 100;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") console.warn("Unable to read downloads store", basename(path)); }
  return fallback;
}

function cleanName(source) {
  // Strip path components, control characters and platform-reserved characters.
  const clean = [...source].map(char => char.codePointAt(0) < 32 ? "_" : char).join("");
  let name = clean.split(/[\\/]/u).at(-1)
    .replace(/[<>:"|?*]/gu, "_").replace(/[. ]+$/u, "") || "download";
  while (Buffer.byteLength(name, "utf8") > 180) name = [...name].slice(0, -1).join("");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  return name;
}

function freePath(directory, name, taken) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let path = join(directory, name);
  for (let n = 1; taken.has(path) || existsSync(path); n++) path = join(directory, `${stem} (${n})${extension}`);
  return path;
}

/** Change-driven accounting includes all tabs and concurrent transfers of a session. */
export class BrowserDownloads {
  constructor(browser, directory) {
    this.browser = browser; this.directory = directory;
    this.active = new Set(); this.persistence = Promise.resolve();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.totals = readJson(join(directory, "budget.json"), {});
    this.history = readJson(join(directory, "history.json"), []).map(entry => entry.state === "progress" ? { ...entry, state: "failed" } : entry);
    this.live = new Map();
  }
  record(item, fields) {
    const entry = { id: randomUUID(), url: item.getURL(), bytes: 0, total: Math.max(0, item.getTotalBytes()),
      state: "progress", time: new Date().toISOString(), ...fields };
    this.history.unshift(entry);
    this.history = this.history.slice(0, HISTORY_LIMIT);
    this.changed(true);
    return entry;
  }
  update(entry, fields, persist) {
    Object.assign(entry, fields);
    this.changed(persist);
  }
  changed(persist) {
    const win = this.browser.getWindow?.();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("butler-browser:downloads", this.history);
    }
    if (persist) this.writeJson("history.json", () => this.history);
  }
  writeJson(name, value) {
    const write = async () => {
      const path = join(this.directory, name), temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(value()), { mode: 0o600 });
      await rename(temporary, path);
    };
    this.persistence = this.persistence.then(write, write);
    void this.persistence.catch(() => {});
  }
  list() { return this.history; }
  entry(id) { return this.history.find(entry => entry.id === id); }
  startUser(item, directory) {
    mkdirSync(directory, { recursive: true });
    const taken = new Set(this.history.filter(entry => entry.state === "progress").map(entry => entry.path));
    const path = freePath(directory, cleanName(item.getFilename()), taken);
    item.setSavePath(path);
    const entry = this.record(item, { name: basename(path), path });
    this.live.set(entry.id, () => item.cancel());
    const end = state => { this.live.delete(entry.id); this.update(entry, { bytes: item.getReceivedBytes(), state }, true); };
    // Chromium retries a dropped transfer itself; "interrupted" here means it gave up, and no "done" follows.
    item.on("updated", (_event, state) => state === "interrupted" ? end("failed")
      : this.update(entry, { bytes: item.getReceivedBytes(), total: Math.max(0, item.getTotalBytes()) }, false));
    item.once("done", (_event, state) => end(state === "completed" ? "done" : state === "cancelled" ? "cancelled" : "failed"));
  }
  start(item, tab) {
    const owner = tab.owner;
    const transfer = { item, tab: { id: tab.id, owner, epoch: tab.epoch }, bytes: 0, total: Math.max(0, item.getTotalBytes()), sourceFilename: item.getFilename(),
      stage: join(tmpdir(), `butler-download-${randomUUID()}`), owner, reason: null };
    // Set synchronously during will-download, so conversation pages never show a dialog.
    item.setSavePath(transfer.stage); item.pause(); this.active.add(transfer);
    transfer.entry = this.record(item, { name: transfer.sourceFilename, path: "" });
    this.live.set(transfer.entry.id, () => this.cancel(transfer, "download_cancelled"));
    item.on("updated", (_event, state) => {
      if (state === "interrupted") return;
      transfer.bytes = item.getReceivedBytes();
      transfer.total = Math.max(0, item.getTotalBytes());
      this.update(transfer.entry, { bytes: transfer.bytes, total: transfer.total }, false);
      const reason = this.limit(transfer, Math.max(transfer.total, transfer.bytes));
      if (reason) this.cancel(transfer, reason);
    });
    item.once("done", (_event, state) => {
      transfer.bytes = item.getReceivedBytes();
      transfer.done = true;
      void this.finish(transfer, state).catch(() => this.event(transfer, "download_failed", { reason: "download_storage_failed" }));
    });
    transfer.preparing = this.prepare(transfer).catch(() => this.cancel(transfer, "download_workspace_unavailable"));
  }
  limit(transfer, bytes) {
    if (bytes > FILE_LIMIT) return "download_file_limit";
    const used = Number(this.totals[transfer.owner] ?? 0);
    const pending = [...this.active].filter(t => !t.accounted && t !== transfer && t.owner === transfer.owner)
      .reduce((sum, t) => sum + Math.max(t.bytes, t.total), 0);
    return used + pending + bytes > SESSION_LIMIT ? "download_session_limit" : null;
  }
  async prepare(transfer) {
    const reason = this.limit(transfer, transfer.total);
    if (reason) { this.cancel(transfer, reason); return; }
    const session = transfer.owner.slice(13);
    const context = await this.browser.downloadRequest({ op: "prepare", session, tab: transfer.tab.id });
    const root = await realpath(context.workspace_path);
    const directory = join(root, "downloads");
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error("download_symlink_refused");
    transfer.filename = cleanName(transfer.sourceFilename);
    transfer.directory = directory;
    transfer.destination = join(directory, transfer.filename);
    if (!transfer.done && !transfer.reason && this.active.has(transfer)) transfer.item.resume();
  }
  cancel(transfer, reason) {
    if (transfer.reason) return;
    transfer.reason = reason;
    this.event(transfer, "download_refused", { reason, file_limit_bytes: FILE_LIMIT, session_limit_bytes: SESSION_LIMIT });
    if (!transfer.done) transfer.item.cancel();
  }
  event(transfer, type, data) {
    browserEvent(this.browser, transfer.tab, type, data);
    const win = this.browser.getWindow?.();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("butler-browser:download", { type, session: transfer.owner.slice(13), reason: data.reason });
    }
  }
  async finish(transfer, state) {
    try {
      await transfer.preparing;
      if (state !== "completed" || transfer.reason || !transfer.destination) {
        if (!transfer.reason) this.event(transfer, "download_failed", { reason: "download_interrupted" });
        return;
      }
      const reason = this.limit(transfer, transfer.bytes);
      if (reason) { this.cancel(transfer, reason); return; }
      // Exclusive copy never replaces an existing path, including across volumes.
      await chmod(transfer.stage, 0o600);
      await copyFile(transfer.stage, transfer.destination, constants.COPYFILE_EXCL).catch(async error => {
        if (error.code !== "EEXIST") throw error;
        transfer.filename = `${randomUUID()}-${transfer.filename}`;
        transfer.destination = join(transfer.directory, transfer.filename);
        await copyFile(transfer.stage, transfer.destination, constants.COPYFILE_EXCL);
      });
      transfer.landed = true;
      transfer.accounted = true;
      this.totals[transfer.owner] = Number(this.totals[transfer.owner] ?? 0) + transfer.bytes;
      this.writeJson("budget.json", () => this.totals);
      await this.persistence;
      this.event(transfer, "download_completed", { path: `downloads/${transfer.filename}`, size_bytes: transfer.bytes });
    } finally {
      try { await unlink(transfer.stage).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      finally {
        this.active.delete(transfer);
        const entry = transfer.entry;
        this.live.delete(entry.id);
        this.update(entry, {
          state: transfer.landed ? "done" : transfer.reason === "download_cancelled" ? "cancelled" : "failed",
          name: transfer.filename ?? entry.name, path: transfer.landed ? transfer.destination : "", bytes: transfer.bytes,
        }, true);
      }
    }
  }
  cancelEntry(id) { this.live.get(id)?.(); }
  cancelTab(id) { for (const transfer of this.active) if (transfer.tab.id === id) this.cancel(transfer, "download_cancelled"); }
  stop() { for (const transfer of this.active) this.cancel(transfer, "download_cancelled"); }
}
