export interface NativeServiceChildLifecycle {
  detached: boolean;
  terminationTarget(pid: number): number;
  processGroupId(pid: number): number | undefined;
}

export function nativeServiceChildLifecycle(
  platform: NodeJS.Platform = process.platform,
): NativeServiceChildLifecycle {
  if (platform === "win32") {
    return {
      detached: false,
      terminationTarget: (pid) => pid,
      processGroupId: () => undefined,
    };
  }
  return {
    detached: true,
    terminationTarget: (pid) => -pid,
    processGroupId: (pid) => pid,
  };
}
