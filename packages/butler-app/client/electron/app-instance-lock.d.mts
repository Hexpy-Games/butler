import type { App } from "electron";

export function requestAppSingleInstanceLock(app: App, writableRoot?: string | null): boolean;
