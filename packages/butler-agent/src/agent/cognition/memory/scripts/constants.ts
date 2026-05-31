import { join } from "path";
import { homedir } from "os";
import { cognitionMemoryRoot, cognitionRoot } from "../../paths.ts";
import { butlerAgentScriptPath } from "../../../../runtime/paths.ts";

const BUTLER_HOME = process.env.BUTLER_HOME || process.cwd();
const BUTLER_DATA = process.env.BUTLER_DATA || join(homedir(), ".butler");
const BUTLER_COGNITION = cognitionRoot(BUTLER_DATA);
const BUTLER_COGNITION_MEMORY = cognitionMemoryRoot(BUTLER_DATA);

export const BUTLER_DIR = {
  HOME: BUTLER_HOME,
  DATA: BUTLER_DATA,
  COGNITION: BUTLER_COGNITION,
  TASKS: join(BUTLER_DATA, "tasks"),
  SCRIPTS: butlerAgentScriptPath(BUTLER_HOME),
  CONFIG: join(BUTLER_HOME, "config"),
  MEMORY: BUTLER_COGNITION_MEMORY,
  LOGS: join(BUTLER_DATA, "logs"),
};

// Hot-cache size thresholds shared across compact.ts and save_hot.ts
export const TWENTY_KB = 20 * 1024;
export const FORTY_KB = 40 * 1024;
