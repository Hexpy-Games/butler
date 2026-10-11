import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserEvent } from "./events.mjs";

export const FILE_LIMIT = 100_000_000;
export const SESSION_LIMIT = 500_000_000;

/** Change-driven accounting includes all tabs and concurrent transfers of a session. */
export class BrowserDownloads {
  constructor(browser, directory) {
    this.browser = browser; this.directory = directory;
    this.active = new Set(); this.totals = {}; this.persistence = Promise.resolve();
  }
  initialize() {
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(async () => {
      try { this.totals = JSON.parse(await readFile(join(this.directory, "budget.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    });
    return this.ready;
  }
  start(item, tab) {
    const owner = tab.owner;
    const transfer = { item, tab: { id: tab.id, owner, epoch: tab.epoch }, bytes: 0, total: Math.max(0, item.getTotalBytes()), sourceFilename: item.getFilename(),
      stage: join(tmpdir(), `butler-download-${randomUUID()}`), owner, reason: null };
    // Set synchronously during will-download, so conversation pages never show a dialog.
    item.setSavePath(transfer.stage); item.pause(); this.active.add(transfer);
    item.on("updated", (_event, state) => {
      if (state === "interrupted") return;
      transfer.bytes = item.getReceivedBytes();
      transfer.total = Math.max(0, item.getTotalBytes());
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
    await this.initialize();
    const reason = this.limit(transfer, transfer.total);
    if (reason) { this.cancel(transfer, reason); return; }
    const session = transfer.owner.slice(13);
    transfer.context = await this.browser.downloadRequest({ op: "prepare", session, tab: transfer.tab.id });
    const root = await realpath(transfer.context.workspace_path);
    const directory = join(root, "downloads");
    await mkdir(directory, { recursive: true });
    if (await realpath(directory) !== directory) throw new Error("download_symlink_refused");
    // Strip path components, control characters and platform-reserved characters.
    const clean = [...transfer.sourceFilename].map(char => char.codePointAt(0) < 32 ? "_" : char).join("");
    let name = clean.split(/[\\/]/u).at(-1)
      .replace(/[<>:"|?*]/gu, "_").replace(/[. ]+$/u, "") || "download";
    while (Buffer.byteLength(name, "utf8") > 180) name = [...name].slice(0, -1).join("");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
    transfer.filename = name;
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
      // Exclusive copy never replaces an existing path, including across volumes. Neither this path nor the output opens files.
      await chmod(transfer.stage, 0o600);
      await copyFile(transfer.stage, transfer.destination, constants.COPYFILE_EXCL).catch(async error => {
        if (error.code !== "EEXIST") throw error;
        transfer.filename = `${randomUUID()}-${transfer.filename}`;
        transfer.destination = join(transfer.directory, transfer.filename);
        await copyFile(transfer.stage, transfer.destination, constants.COPYFILE_EXCL);
      });
      transfer.accounted = true;
      this.totals[transfer.owner] = Number(this.totals[transfer.owner] ?? 0) + transfer.bytes;
      this.persistence = this.persistence.then(async () => {
        const path = join(this.directory, "budget.json"), temporary = `${path}.tmp`;
        await writeFile(temporary, JSON.stringify(this.totals), { mode: 0o600 }); await rename(temporary, path);
      });
      await this.persistence;
      const output = await this.browser.downloadRequest({ op: "publish", session: transfer.owner.slice(13),
        tab: transfer.tab.id, filename: transfer.filename, turn_id: transfer.context.turn_id, message_id: transfer.context.message_id });
      this.event(transfer, "download_completed", { path: `downloads/${transfer.filename}`, size_bytes: transfer.bytes, ...output });
    } finally {
      try { await unlink(transfer.stage).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      finally { this.active.delete(transfer); }
    }
  }
  cancelTab(id) { for (const transfer of this.active) if (transfer.tab.id === id) this.cancel(transfer, "download_cancelled"); }
  stop() { for (const transfer of this.active) this.cancel(transfer, "download_cancelled"); }
}
