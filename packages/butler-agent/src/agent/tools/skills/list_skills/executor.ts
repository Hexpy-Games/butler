import { validateSkillCatalog } from "../../../../integrations/skills/catalog.ts";
import { loadRuntimeSkills } from "../../../../integrations/skills/manager.ts";

type ToolCall = { args: Record<string, unknown> };

export function createSkillToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  projectId?: string;
}) {
  return {
    "list_skills": async (_call: ToolCall) => {
      const skills = loadRuntimeSkills({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        projectId: input.projectId,
      });
      return {
        ok: true,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          applicability: skill.applicability,
          allowed_tools: skill.allowedTools,
          dispatch: skill.dispatchPreference,
          review: skill.reviewRequirement,
          reporting: skill.reporting,
          user_invocable: skill.userInvocable,
        })),
        validation_issues: validateSkillCatalog(skills),
      };
    },
  };
}
