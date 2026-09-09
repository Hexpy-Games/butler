#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { butlerDataPath } from "../src/runtime/paths.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const DATA_ROOT = butlerDataPath();

function checkPrerequisites() {
  console.log("Checking prerequisites...");

  const missing: string[] = [];

  if (missing.length > 0) {
    console.error("\nMissing required tools:");
    for (const tool of missing) {
      console.error(`  ${tool}`);
    }
    process.exit(1);
  }

  console.log(`  ✓ Butler runtime (${process.execPath})`);
  console.log("  ✓ native supervisor");
}

function bunInstall() {
  console.log("\nInstalling dependencies with Butler runtime...");
  const result = Bun.spawnSync([process.execPath, "install"], {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error("dependency install failed");
    process.exit(1);
  }
}

function ask(question: string): string {
  return prompt(question) ?? "";
}

function askWithDefault(label: string, defaultValue: string): string {
  const input = ask(`${label} [${defaultValue}]: `);
  return input.trim() || defaultValue;
}

async function configureButler() {
  console.log("\nConfiguring butler.config.json...");

  const configPath = join(DATA_ROOT, "butler.config.json");
  const templatePath = join(PROJECT_ROOT, "butler.config.template.json");

  if (existsSync(configPath)) {
    const answer = ask("Config already exists. Overwrite? (y/N): ");
    if (answer.trim().toLowerCase() !== "y") {
      console.log("  Keeping existing config.");
      return;
    }
  }

  const template = JSON.parse(readFileSync(templatePath, "utf-8"));

  console.log("\nEnter configuration values (press Enter to keep default):\n");

  const name = askWithDefault("User name", template.user.name);
  const timezone = askWithDefault("Timezone", template.user.timezone);
  const language = askWithDefault("Language", template.user.language);
  const butlerHome = askWithDefault("Butler home path", template.system.butlerHome);
  const devRoot = askWithDefault("Dev root", template.system.devRoot);

  console.log("Active persona options: pragmatic / classic / friendly / hacker");
  const activePersona = askWithDefault("Active persona", template.system.activePersona);

  const config = {
    ...template,
    user: {
      ...template.user,
      name,
      timezone,
      language,
    },
    system: {
      ...template.system,
      butlerHome,
      devRoot,
      activePersona,
    },
  };

  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("  ✓ butler.config.json written");
}

function initMemoryStructure() {
  console.log("\nInitializing memory structure...");

  const dataRoot = DATA_ROOT;
  const dirs = [
    "cognition/memory/hot",
    "cognition/memory/db",
    "cognition/memory/projects",
    "tasks",
    "logs",
  ];

  for (const dir of dirs) {
    const fullPath = join(dataRoot, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  ✓ created ${dir}/`);
    } else {
      console.log(`  · ${dir}/ already exists`);
    }
  }

  const profilePath = join(dataRoot, "cognition/memory/user-profile.md");
  if (!existsSync(profilePath)) {
    let name = "User";
    try {
      const config = JSON.parse(
        readFileSync(join(DATA_ROOT, "butler.config.json"), "utf-8"),
      );
      name = config.user?.name ?? name;
    } catch {}

    const profileContent = `# User Profile

## Identity
- Name: ${name}

## Work Style
- (add notes as you learn)

## Interests
- (add notes as you learn)
`;
    writeFileSync(profilePath, profileContent);
    console.log("  ✓ created memory/user-profile.md");
  } else {
    console.log("  · memory/user-profile.md already exists");
  }
}

function printNextSteps() {
  console.log(`
✓ Setup complete.

Next steps:
1. Start butler:
   → ./packages/butler-agent/scripts/start-butler.sh

2. (Optional) Start the embedding server for vector memory:
   → ./packages/butler-agent/scripts/start-embed-server.sh

Full setup guide: README.md
`);
}

// Main
checkPrerequisites();
bunInstall();
await configureButler();
initMemoryStructure();
printNextSteps();
