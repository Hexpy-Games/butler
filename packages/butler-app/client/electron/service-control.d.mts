export const APP_AGENT_SERVICE_CONTROL_SCHEMA:
  "butler.app-agent-service-control.v1";

export function createAgentServiceControl(options?: {
  platform?: string;
  adapter?: {
    getStatus?: () => unknown | Promise<unknown>;
    install?: (request?: unknown) => unknown | Promise<unknown>;
    start?: (request?: unknown) => unknown | Promise<unknown>;
    stop?: (request?: unknown) => unknown | Promise<unknown>;
    restart?: (request?: unknown) => unknown | Promise<unknown>;
    prepareRuntimeUpdate?: (request?: unknown) => unknown | Promise<unknown>;
    applyRuntimeUpdate?: (request?: unknown) => unknown | Promise<unknown>;
    rollbackRuntimeUpdate?: (request?: unknown) => unknown | Promise<unknown>;
    diagnostics?: () => unknown | Promise<unknown>;
  } | null;
  now?: () => Date;
}): {
  getAgentServiceStatus: () => Promise<unknown>;
  installAgentService: (request?: unknown) => Promise<unknown>;
  startAgentService: (request?: unknown) => Promise<unknown>;
  stopAgentService: (request?: unknown) => Promise<unknown>;
  restartAgentService: (request?: unknown) => Promise<unknown>;
  prepareAgentRuntimeUpdate: (request?: unknown) => Promise<unknown>;
  applyAgentRuntimeUpdate: (request?: unknown) => Promise<unknown>;
  rollbackAgentRuntimeUpdate: (request?: unknown) => Promise<unknown>;
  readAgentServiceDiagnostics: () => Promise<unknown>;
};
