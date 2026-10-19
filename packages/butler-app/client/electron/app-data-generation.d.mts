export const DATA_GENERATION_FILE: string;

export function readRecordedDataGeneration(userDataPath: string): Promise<string | null>;
export function reconcileAppDataGeneration(options: {
  userDataPath: string;
  readGeneration: () => Promise<string | null>;
  clearRendererStorage: () => Promise<unknown>;
}): Promise<{ outcome: "unknown" | "recorded" | "same" | "cleared"; resetFailed: boolean }>;
