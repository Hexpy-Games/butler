import { createHash } from "crypto";
import type { PromptSection } from "../prompt/prompt-assembler.ts";

export type PromptSectionStability = "stable-prefix" | "dynamic-suffix";

const STATIC_SECTION_IDS = new Set([
  "runtime-system-contract",
  "role",
  "tool-provider-contract",
]);

const DYNAMIC_SECTION_IDS = new Set([
  "eol",
  "steward-config",
  "persona",
  "personalization-profile",
  "rules",
  "skills",
  "active-persona-reminder",
  "hot-cache",
  "project-memory",
  "project-hot-cache",
  "turn-personalization-profile",
  "first-chat-onboarding",
  "feedback-buffer",
  "profile-projection",
  "working-memory",
  "runtime-state",
  "current-attachments",
  "attachment-references",
  "tool-evidence",
  "worker-evidence",
  "retrieved-context",
  "turn-context",
  "recent-conversation",
  "associative-recall",
  "compaction-summary",
  "inbound-message",
]);

export function classifyPromptSection(sectionId: string): PromptSectionStability {
  if (STATIC_SECTION_IDS.has(sectionId)) return "stable-prefix";
  if (DYNAMIC_SECTION_IDS.has(sectionId)) return "dynamic-suffix";
  throw new Error(`Unknown prompt section stability: ${sectionId}`);
}

export function stablePromptSections(sections: PromptSection[]): PromptSection[] {
  return sections.filter((section) => classifyPromptSection(section.id) === "stable-prefix");
}

export function promptSectionsText(sections: PromptSection[]): string {
  return sections
    .map((section) => `## ${section.title}\n\n${section.content}`)
    .join("\n\n---\n\n");
}

export function stablePromptPrefixHash(sections: PromptSection[]): string {
  const stable = stablePromptSections(sections)
    .map((section) => ({
      id: section.id,
      title: section.title,
      content: section.content,
    }));
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 16);
}
