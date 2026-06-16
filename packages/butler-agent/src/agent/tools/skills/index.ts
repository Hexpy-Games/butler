import { createSkillToolHandlers as createHandlerMap } from "./list_skills/executor.ts";

export function createSkillToolHandlers(input: Parameters<typeof createHandlerMap>[0]) {
  return createHandlerMap(input);
}
