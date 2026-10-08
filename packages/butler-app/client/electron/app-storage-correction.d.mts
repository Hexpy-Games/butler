export function watchStorageCorrection(
  dataRoot: string,
  onProgress: (deadlineAt: number) => void,
): { deadline(): number; close(): void };
