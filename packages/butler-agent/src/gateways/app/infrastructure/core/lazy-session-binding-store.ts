import { existsSync } from "node:fs";
import { SessionBindingStore } from
  "../../../../test-support/harness/session-store.ts";
import type { AppSessionWorkspaceBindingStore } from
  "../../domain/sessions/session-workspace-binding-store.ts";

export class LazyAppSessionBindingStore
  implements AppSessionWorkspaceBindingStore
{
  private store: SessionBindingStore | undefined;

  constructor(private readonly path: string) {}

  getBySessionId(
    ...args: Parameters<SessionBindingStore["getBySessionId"]>
  ): ReturnType<SessionBindingStore["getBySessionId"]> {
    return this.readable()?.getBySessionId(...args) ?? null;
  }

  upsert(
    ...args: Parameters<SessionBindingStore["upsert"]>
  ): ReturnType<SessionBindingStore["upsert"]> {
    return this.writable().upsert(...args);
  }

  rebindWorkspace(
    ...args: Parameters<SessionBindingStore["rebindWorkspace"]>
  ): ReturnType<SessionBindingStore["rebindWorkspace"]> {
    return this.writable().rebindWorkspace(...args);
  }

  deleteSession(
    ...args: Parameters<SessionBindingStore["deleteSession"]>
  ): ReturnType<SessionBindingStore["deleteSession"]> {
    return this.readable()?.deleteSession(...args);
  }

  close(): void {
    this.store?.close();
    this.store = undefined;
  }

  private readable(): SessionBindingStore | undefined {
    if (this.store) return this.store;
    if (!existsSync(this.path)) return undefined;
    this.store = new SessionBindingStore(this.path);
    return this.store;
  }

  private writable(): SessionBindingStore {
    return this.readable() ?? (this.store = new SessionBindingStore(this.path));
  }
}
