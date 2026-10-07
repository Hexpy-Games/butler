export function lifecycleDist(): string;
export function createLifecycleWindow(options: Record<string, unknown>): { window: unknown; update(state: Record<string, unknown>): void; destroy(): void };
