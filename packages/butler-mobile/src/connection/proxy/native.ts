import { requireNativeModule } from "expo";

export type ProxyRequestEvent = { id: number; port: number; method: string; target: string; headers: Record<string, string> };
type Subscription = { remove(): void };
type ButlerProxyModule = {
  start(): Promise<number>;
  stop(port: number): void;
  respondHead(id: number, status: number, headers: Record<string, string>): void;
  respondChunk(id: number, bytes: Uint8Array): Promise<void>;
  respondEnd(id: number): void;
  respondAbort(id: number): void;
  addListener(event: "onRequest", listener: (event: ProxyRequestEvent) => void): Subscription;
  addListener(event: "onCancel", listener: (event: { id: number }) => void): Subscription;
};

export const ButlerProxy = requireNativeModule<ButlerProxyModule>("ButlerProxy");
