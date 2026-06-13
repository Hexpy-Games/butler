export function createTrayAgentMenuModel(status?: {
  status?: string;
  service_available?: boolean;
}): {
  label: string;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
};

export function trayAgentServiceLabel(status?: { status?: string }): string;
