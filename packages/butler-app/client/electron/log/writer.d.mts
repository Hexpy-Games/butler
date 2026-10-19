export interface AppRecord {
  level: string;
  category: string;
  event: string;
  msg: string;
  attrs?: unknown;
  trace_id?: string;
  span_id?: string;
  chat_id?: string;
  turn_id?: string;
  duration_ms?: number;
  error?: unknown;
}
export function createAppLogWriter(root: string | null, canWrite?: () => boolean): {
  record(row: AppRecord, process?: "app.main" | "app.renderer", body?: unknown): void;
  configure(view: { clear_generation?: string | null; full_expires_at?: string | null; effective: { level: string; category_levels: Record<string, string> } }): void;
  enabled(category: string, level: string): boolean;
  remember(value: unknown): void;
  clear(): Promise<void>;
  flush(): Promise<void>;
  quit(timeout?: number): Promise<void>;
  readonly failure: string | null;
};
