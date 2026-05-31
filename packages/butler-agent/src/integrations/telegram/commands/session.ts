// In-memory session state for multi-step command flows.
//
// Keyed by `${chatId}:${userId}:${command}` — one live session per user per
// command at a time. TTL bounds stale-callback risk: if the user presses a
// button 15 minutes after opening the menu, the session is gone and the
// router returns an "expired" notice instead of mutating state blindly.

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type SessionState = Record<string, unknown>;

type Entry = {
  state: SessionState
  expiresAt: number
};

export class SessionStore {
  private readonly map = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private key(chatId: string | number, userId: string | number, command: string): string {
    return `${chatId}:${userId}:${command}`;
  }

  set(chatId: string | number, userId: string | number, command: string, state: SessionState): void {
    this.map.set(this.key(chatId, userId, command), {
      state,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  get(chatId: string | number, userId: string | number, command: string): SessionState | null {
    const k = this.key(chatId, userId, command);
    const entry = this.map.get(k);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(k);
      return null;
    }
    return entry.state;
  }

  clear(chatId: string | number, userId: string | number, command: string): void {
    this.map.delete(this.key(chatId, userId, command));
  }

  // Prune expired entries. Called periodically to bound memory growth;
  // get() also lazily evicts, so this is belt-and-braces.
  prune(): number {
    const now = this.now();
    let n = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.expiresAt <= now) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.map.size;
  }
}
