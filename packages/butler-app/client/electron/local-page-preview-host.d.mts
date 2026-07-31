export interface LocalPagePreviewViewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

export interface LocalPagePreviewHost {
  start(): Promise<string>;
  endpoint(): string | null;
  stop(): Promise<void>;
}

export function createLocalPagePreviewHost(input: {
  BrowserWindow: new (...args: never[]) => unknown;
  token?: string;
  viewports?: LocalPagePreviewViewport[];
}): LocalPagePreviewHost;
