import { resolve } from "node:path";

// OS integration belongs to the installed App's default profile. An alternate
// profile must not replace the user's global protocol or startup registrations.
export function shellRegistrationAllowed({ isPackaged, env, home, dataRoot }) {
  return isPackaged &&
    env.BUTLER_APP_DISABLE_SHELL_REGISTRATION !== "1" &&
    !env.BUTLER_APP_ELECTRON_USER_DATA_DIR &&
    !env.BUTLER_DATA?.trim() &&
    (!env.HOME || resolve(env.HOME) === resolve(home)) &&
    resolve(dataRoot) === resolve(home, ".butler");
}
