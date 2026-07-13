export const APP_FOREGROUND_QUIT_COPY: string;
export interface AppForegroundActiveWorkSnapshot {
  classification: "no_active_work" | "active_work_detected" | "active_work_unknown";
  reasons: string[];
  raw_text_included: false;
}
export function classifyAppForegroundActiveWork(
  input?: Record<string, unknown>,
): AppForegroundActiveWorkSnapshot;
export function confirmAppForegroundQuit(input: {
  snapshot: AppForegroundActiveWorkSnapshot;
  showMessageBox: (options: Record<string, unknown>) => Promise<{ response: number }>;
}): Promise<boolean>;
