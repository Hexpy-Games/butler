export function createTrayAgentMenuModel(status = {}) {
  const agentStatus = typeof status.status === "string" ? status.status : "not_installed";
  const serviceAvailable = status.service_available === true;
  const canStart = serviceAvailable &&
    ["stopped", "failed"].includes(agentStatus);
  const canStop = serviceAvailable &&
    ["ready", "starting", "updating", "restarting", "draining"].includes(agentStatus);
  const canRestart = serviceAvailable &&
    ["ready", "failed", "stopped"].includes(agentStatus);
  return {
    label: trayAgentServiceLabel(status),
    canStart,
    canStop,
    canRestart,
  };
}

export function trayAgentServiceLabel(status = {}) {
  switch (status.status) {
    case "ready":
      return "Butler Agent: Running";
    case "starting":
    case "installing":
      return "Butler Agent: Starting";
    case "updating":
    case "restarting":
    case "draining":
      return "Butler Agent: Updating";
    case "stopped":
      return "Butler Agent: Stopped";
    case "needs_permission":
      return "Butler Agent: Needs Setup";
    case "rollback":
      return "Butler Agent: Rollback";
    case "failed":
      return "Butler Agent: Failed";
    case "not_installed":
    default:
      return "Butler Agent: Not Installed";
  }
}
