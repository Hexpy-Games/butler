import { setTimeout as delay } from "node:timers/promises";
import { applyEvents } from "./phone-input.mjs";

export class PhoneLive {
  feeds = new Map();

  constructor(browser) {
    this.browser = browser;
  }

  async execute(frame) {
    const { browser } = this;
    if (browser.disposing) return { status: "refused", reason: "live_unavailable" };
    const tab = browser.tabs.get(frame.tab);
    if (tab?.owner !== `conversation:${frame.session}`) return { status: "refused", reason: "not_your_tab" };
    try {
      if (frame.op === "live.start") return await this.start(tab, frame.args, frame.deliverLive);
      if (frame.op === "live.input") return await this.input(tab, frame.args);
      if (frame.op === "live.stop") {
        if (this.feeds.get(tab.id)?.sub === frame.args.sub) await this.stop(tab.id);
        return { status: "ok" };
      }
    } catch { /* A disappearing page can refuse a command partway through. */ }
    return { status: "refused", reason: "live_unavailable" };
  }

  async start(tab, { sub, width }, deliver) {
    const contents = tab.view?.webContents;
    const unavailable = { status: "refused", reason: "live_unavailable" };
    if (tab.holder !== "user" || !contents || contents.isDestroyed() || !tab.debuggerReady) return unavailable;
    if (this.feeds.get(tab.id)?.sub === sub) return { status: "ok" };
    const stopped = this.stop(tab.id);
    const feed = { sub, contents, lastAck: -Infinity, pending: Promise.resolve() };
    feed.destroyed = () => { void this.stop(tab.id); };
    feed.message = (_event, method, params, sessionId) => {
      if (method !== "Page.screencastFrame" || sessionId) return;
      feed.pending = feed.pending.then(async () => {
        if (this.feeds.get(tab.id) !== feed) return;
        if (tab.holder !== "user") { await this.stop(tab.id); return; }
        const { width, height } = tab.view.getBounds();
        const response = await deliver({ width, height, jpeg: params.data });
        if (this.feeds.get(tab.id) !== feed) return;
        if (response.status === 404) { await this.stop(tab.id); return; }
        if (!response.ok) return;
        const wait = feed.lastAck + 100 - performance.now();
        if (wait > 0) await delay(Math.ceil(wait));
        if (this.feeds.get(tab.id) !== feed) return;
        if (tab.holder !== "user") { await this.stop(tab.id); return; }
        feed.lastAck = performance.now();
        await contents.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId });
      }).catch(() => {});
    };
    this.feeds.set(tab.id, feed);
    contents.once("destroyed", feed.destroyed);
    try {
      await stopped;
      await tab.debuggerReady;
      if (this.feeds.get(tab.id) !== feed) return unavailable;
      if (tab.holder !== "user") { await this.stop(tab.id); return unavailable; }
      contents.debugger.on("message", feed.message);
      const w = Math.max(320, Math.min(1280, width));
      await contents.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: w, maxHeight: 2 * w, everyNthFrame: 1 });
      return this.feeds.get(tab.id) === feed ? { status: "ok" } : unavailable;
    } catch {
      if (this.feeds.get(tab.id) === feed) await this.stop(tab.id);
      return unavailable;
    }
  }

  async stop(id) {
    const feed = this.feeds.get(id);
    if (!feed) return;
    this.feeds.delete(id);
    const { contents } = feed;
    contents.removeListener("destroyed", feed.destroyed);
    if (contents.isDestroyed()) return;
    contents.debugger.removeListener("message", feed.message);
    await contents.debugger.sendCommand("Page.stopScreencast").catch(() => {});
  }

  reset() {
    for (const id of this.feeds.keys()) void this.stop(id);
  }

  async input(tab, { sub, events }) {
    const feed = this.feeds.get(tab.id);
    if (tab.holder !== "user" || !feed || feed.sub !== sub) return { status: "refused", reason: "live_not_held" };
    if (events.some(event => event.t === "text" || event.t === "key")) tab.userTyped = true;
    return applyEvents(tab, feed, events);
  }
}
