export interface UsageBrowser {
  tabs: Map<string, Record<string, unknown>>;
  holds: Map<string, Map<string, string>>;
  uses: Map<string, unknown>;
  events?: Map<string, unknown[]>;
  publish(): void;
  close(id: string): void;
}
export function finishUse(browser: UsageBrowser, session: string, turn: string, closeReadTabs?: boolean): void;
