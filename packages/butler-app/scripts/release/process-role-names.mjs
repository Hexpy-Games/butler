const ROLES = ["memory", "restart", "update"];

export function processRoleFileNames(platform = process.platform) {
  if (platform === "darwin") return ROLES.map((role) => `butler-agent (${role})`);
  if (platform === "win32") return ROLES.map((role) => `butler-agent (${role}).exe`);
  return ROLES.map((role) => `butler-${role}`);
}

export function legacyProcessRoleFileNames() {
  return ROLES.map((role) => `butler(${role})`);
}
