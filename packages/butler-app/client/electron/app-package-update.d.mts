export interface AppPackageUpdateOptions {
  artifactPath: string;
  dataRoot: string;
  installation: { command: string; args: string[]; env?: Record<string, string | undefined> };
  executable: string;
  parent: number;
  externalServerUrl?: string | null;
  arguments?: string[];
  onStage?: (stage: "verifying" | "ready") => Promise<void>;
}
export function prepareAppPackageUpdate(options: AppPackageUpdateOptions): Promise<{
  activate: () => void;
  cancel: () => void;
}>;
