export function bindWindowsTrayInteractions(
  tray: {
    on(event: "click" | "double-click", handler: () => void): unknown;
    popUpContextMenu(): unknown;
  },
  openButler: () => void,
): boolean;

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
