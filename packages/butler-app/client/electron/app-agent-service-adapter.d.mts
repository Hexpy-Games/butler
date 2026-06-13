export function createAppAgentServiceAdapter(options?: {
  nativeServices?: {
    list?: () => unknown[] | Promise<unknown[]>;
    start?: (request?: unknown) => unknown | Promise<unknown>;
    stop?: (request?: unknown) => unknown | Promise<unknown>;
  } | null;
  registration?: {
    install?: (request?: unknown) => unknown | Promise<unknown>;
  } | null;
}): {
  getStatus: () => Promise<unknown>;
  install: (request?: unknown) => Promise<unknown>;
  start: (request?: unknown) => Promise<unknown>;
  stop: (request?: unknown) => Promise<unknown>;
  restart: (request?: unknown) => Promise<unknown>;
  diagnostics: () => Promise<unknown>;
};
