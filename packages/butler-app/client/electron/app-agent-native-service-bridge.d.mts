export function createAppAgentNativeServiceBridge(options?: {
  butlerData: string;
  platform?: string;
  homeDir?: string;
  getPort?: () => number;
  ensureRuntimePointer?: () => {
    rollbackActivation?: (error?: Error) => void;
  } | void;
  prepareLocalAuth?: () => { filePath: string };
  isPidRunning?: (pid: number) => boolean;
  runCommand?: (argv: string[]) => { exitCode: number } | Promise<{ exitCode: number }>;
  writeFile?: (path: string, body: string) => void;
}): {
  nativeServices: {
    list: () => Promise<unknown[]>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
  registration: {
    install: () => Promise<void>;
  };
};

export function listNativeServiceProjections(input: {
  butlerData: string;
  isPidRunning?: (pid: number) => boolean;
}): Array<{
  serviceId: string;
  pid: number | null;
  status: "online" | "offline" | "stale";
}>;
