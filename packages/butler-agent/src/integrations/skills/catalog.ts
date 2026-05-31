import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export type DispatchPreference = "none" | "direct" | "planned" | "auto";
export type ReviewRequirement = "none" | "recommended" | "required";

export interface SkillDefinition {
  name: string;
  description: string;
  applicability: string;
  allowedTools: string[];
  dispatchPreference: DispatchPreference;
  reviewRequirement: ReviewRequirement;
  reporting: string;
  filePath: string;
  instructions: string;
  userInvocable: boolean;
}

export interface SkillValidationIssue {
  filePath: string;
  message: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2] };
}

function listValue(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDispatch(value: string | undefined): DispatchPreference {
  if (value === "none" || value === "direct" || value === "planned" || value === "auto") return value;
  return "none";
}

function normalizeReview(value: string | undefined): ReviewRequirement {
  if (value === "none" || value === "recommended" || value === "required") return value;
  return "none";
}

export function readSkillDefinition(filePath: string): SkillDefinition | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const { meta, body } = parseFrontmatter(content);
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description ?? "",
    applicability: meta.applicability ?? "",
    allowedTools: listValue(meta["allowed-tools"]),
    dispatchPreference: normalizeDispatch(meta.dispatch),
    reviewRequirement: normalizeReview(meta.review),
    reporting: meta.reporting ?? "",
    userInvocable: meta["user-invocable"] === "true",
    filePath,
    instructions: body.trim(),
  };
}

export function loadSkillCatalog(skillsDir: string): SkillDefinition[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .map((entry) => readSkillDefinition(join(skillsDir, entry, "SKILL.md")))
    .filter((skill): skill is SkillDefinition => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function validateSkillCatalog(skills: SkillDefinition[]): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      issues.push({ filePath: skill.filePath, message: `duplicate skill name: ${skill.name}` });
    }
    names.add(skill.name);
    if (!skill.description.trim()) issues.push({ filePath: skill.filePath, message: "description is required" });
    if (!skill.applicability.trim()) issues.push({ filePath: skill.filePath, message: "applicability is required" });
    if (skill.allowedTools.length === 0) issues.push({ filePath: skill.filePath, message: "allowed-tools are required" });
    if (!skill.reporting.trim()) issues.push({ filePath: skill.filePath, message: "reporting is required" });
    if (!skill.instructions.trim()) issues.push({ filePath: skill.filePath, message: "instructions body is required" });
  }
  return issues;
}

export function renderSkillPromptSection(skills: SkillDefinition[]): string | null {
  if (skills.length === 0) return null;
  return skills
    .map((skill) => [
      `- ${skill.name}: ${skill.description}`,
      `  applicability: ${skill.applicability}`,
      `  tools: ${skill.allowedTools.join(", ")}`,
      `  dispatch: ${skill.dispatchPreference}; review: ${skill.reviewRequirement}; reporting: ${skill.reporting}`,
    ].join("\n"))
    .join("\n");
}
