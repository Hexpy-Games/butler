export function windowsPowerShellEnvironment(env = process.env, overrides = {}) {
  const environment = { ...env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.toLocaleLowerCase("en-US") === "psmodulepath") {
      delete environment[key];
    }
  }
  return environment;
}
