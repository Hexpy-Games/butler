import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { BUTLER_DIR } from "./constants.ts";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export interface Skill {
  name: string;
  description: string;
  applicability: string;
  model?: string;
  userInvocable: boolean;
  instructions: string;
  filePath: string;
  source: string;
}

const DEFAULT_SKILL_DIRS = [
  butlerAgentResourcesPath(BUTLER_DIR.HOME, "skills"),
];

const SKILL_DIRS: string[] = process.env.BUTLER_SKILL_DIRS
  ? process.env.BUTLER_SKILL_DIRS.split(":").map((p) => p.replace(/^~/, homedir()))
  : DEFAULT_SKILL_DIRS;

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue === "true") {
      meta[key] = true;
    } else if (rawValue === "false") {
      meta[key] = false;
    } else {
      meta[key] = rawValue;
    }
  }

  return { meta, body: match[2] };
}

let skills: Skill[] = [];

async function loadSkillsFromDir(sourceDir: string): Promise<Skill[]> {
  const skillsDir = sourceDir;
  if (!existsSync(skillsDir)) return [];

  const sourceName = sourceDir.split("/").pop() || "local";

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const result: Skill[] = [];
  for (const entry of entries) {
    const skillFile = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const content = await readFile(skillFile, "utf8");
      const { meta, body } = parseFrontmatter(content);

      if (!meta.name) continue;

      result.push({
        name: meta.name,
        description: meta.description || "",
        applicability: meta.applicability || "",
        model: meta.model,
        userInvocable: meta["user-invocable"] === true,
        instructions: body.trim(),
        filePath: skillFile,
        source: sourceName,
      });
    } catch {
      // skip malformed skill
    }
  }

  return result;
}

export async function loadSkills(): Promise<void> {
  skills = [];

  for (const skillDir of SKILL_DIRS) {
    if (!existsSync(skillDir)) continue;
    const loaded = await loadSkillsFromDir(skillDir);
    skills.push(...loaded);
  }

  console.error(
    `Loaded ${skills.length} skill(s)${skills.length > 0 ? ": " + skills.map((s) => `${s.source}/${s.name}`).join(", ") : ""}`,
  );
}

export function getSkills(): Skill[] {
  return skills;
}
