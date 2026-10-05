import { randomUUID } from "node:crypto";

/** One owner for update choice, deferred activation and failure feedback. */
export function createAppUpdateCoordinator(input) {
  return new AppUpdateCoordinator(input);
}

class AppUpdateCoordinator {
  constructor({ readActiveWork, watchWork, stopForUpdate, onState }) {
    Object.assign(this, { readActiveWork, watchWork, stopForUpdate, onState });
    this.current = { status: "idle", request_id: null };
    this.pending = null;
    this.choice = null;
    this.unwatch = null;
    this.checking = false;
    this.dirty = false;
  }

  state() { return { ...this.current }; }

  publish(status, request_id = null) {
    this.current = { status, request_id };
    this.onState(this.state());
  }

  request(prepare) {
    if (this.pending) return this.pending;
    if (["deferred", "preparing", "restarting"].includes(this.current.status)) {
      return Promise.resolve({ status: this.current.status, update_started: false });
    }
    this.pending = this.begin(prepare);
    return this.pending;
  }

  choose({ request_id, action } = {}) {
    if (!this.choice || request_id !== this.current.request_id || !["now", "defer"].includes(action)) return { ok: false };
    const resolve = this.choice;
    this.choice = null;
    resolve(action);
    return { ok: true };
  }

  dispose() {
    this.unwatch?.();
    this.unwatch = null;
  }

  async install(prepare, waitForWork = false) {
    this.publish("preparing");
    let helper;
    try {
      helper = await prepare();
      if (waitForWork && (await this.readActiveWork()).classification !== "no_active_work") {
        helper.cancel();
        this.publish("deferred");
        return { status: "deferred", update_started: false };
      }
      this.publish("restarting");
      const stopped = await this.stopForUpdate();
      if (stopped?.update_ready !== true) throw new Error("update_checkpoint_failed");
      // The host sets its quit bypass before activating the verified helper.
      // The helper waits for this exact process to exit before bundle swap.
      await helper.activate();
      return { status: "update_started", update_started: true };
    } catch (error) {
      helper?.cancel();
      this.publish("failed");
      throw error;
    }
  }

  async checkDeferred(prepare) {
    this.dirty = true;
    if (this.checking || this.current.status !== "deferred") return;
    this.checking = true;
    try {
      while (this.dirty && this.current.status === "deferred") {
        this.dirty = false;
        const snapshot = await this.readActiveWork();
        if (snapshot.classification !== "no_active_work") continue;
        this.dispose();
        const result = await this.install(prepare, true);
        if (result.status === "deferred") {
          this.unwatch = this.watchWork(() => { void this.checkDeferred(prepare); });
          this.dirty = true;
        }
      }
    } catch {
      this.dispose();
      this.publish("failed");
    } finally {
      this.checking = false;
      if (this.current.status !== "deferred") this.pending = null;
    }
  }

  async begin(prepare) {
    try {
      const snapshot = await this.readActiveWork();
      if (!["no_active_work", "active_work_detected"].includes(snapshot.classification)) {
        throw new Error("update_work_state_unavailable");
      }
      if (snapshot.classification === "active_work_detected") {
        const selected = new Promise(resolve => { this.choice = resolve; });
        this.publish("choice_required", randomUUID());
        if (await selected === "defer") {
          this.publish("deferred");
          this.unwatch = this.watchWork(() => { void this.checkDeferred(prepare); });
          // Subscribe before rereading: settlement between choice and watch
          // must not leave an otherwise idle update waiting indefinitely.
          void this.checkDeferred(prepare);
          return { status: "deferred", update_started: false };
        }
      }
      return await this.install(prepare);
    } catch (error) {
      this.publish("failed");
      throw error;
    } finally {
      this.choice = null;
      this.pending = null;
    }
  }
}
