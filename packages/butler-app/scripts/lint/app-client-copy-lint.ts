import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");

type Finding = {
  line: number;
  text: string;
  reason: string;
};

const conversationRenderer = join(
  root,
  "packages",
  "butler-app",
  "client",
  "ui",
  "src",
  "components",
  "conversation",
  "Conversation.tsx",
);

const forbiddenConversationLiterals = [
  "작업",
  "결과",
  "요청을 처리하고 있습니다.",
  "작업 내역 열기",
  "작업 내역 닫기",
];

const findings: Finding[] = [];
const source = readFileSync(conversationRenderer, "utf8");

source.split("\n").forEach((line, index) => {
  for (const literal of forbiddenConversationLiterals) {
    if (!line.includes(literal)) continue;
    findings.push({
      line: index + 1,
      text: line.trim(),
      reason: `user-visible conversation copy must come from packages/butler-app/client/ui/src/app/copy.ts, found ${JSON.stringify(literal)}`,
    });
  }
});

if (!source.includes('import { appCopy } from "@/app/copy.ts";')) {
  findings.push({
    line: 1,
    text: "missing appCopy import",
    reason: "conversation renderer must use the app copy dictionary for visible turn labels",
  });
}

// Components whose visible labels must come from butler-i18n (via app copy or
// caller props) instead of hardcoded English text or English prop defaults.
const localizedComponentFiles = [
  "libs/design-system/shadcn/ui/dialog.tsx",
  "components/management/ProjectStatsGrid.tsx",
  "components/management/ProjectWorkStatistics.tsx",
  "libs/design-system/blocks/WorkerActivityRow/WorkerActivityRow.tsx",
  "libs/design-system/blocks/CommandPanel/CommandPanel.tsx",
  "libs/design-system/blocks/DocumentTile/DocumentTile.tsx",
];

const hardcodedEnglishLabelPatterns = [
  { pattern: /\b(?:aria-label|label|placeholder|title)="[A-Za-z][^"]*"/u, reason: "literal English label attribute" },
  { pattern: /\b\w*(?:Label|placeholder)\s*=\s*"[A-Za-z][^"]*"/u, reason: "English default for a label prop" },
  { pattern: />\s*[A-Z][a-z]+(?:\s+[A-Za-z]+)*\s*</u, reason: "hardcoded English JSX text" },
];

const localizedFindings: Array<Finding & { path: string }> = [];
for (const file of localizedComponentFiles) {
  const path = `packages/butler-app/client/ui/src/${file}`;
  readFileSync(join(root, path), "utf8").split("\n").forEach((line, index) => {
    for (const { pattern, reason } of hardcodedEnglishLabelPatterns) {
      if (!pattern.test(line)) continue;
      localizedFindings.push({
        path,
        line: index + 1,
        text: line.trim(),
        reason: `${reason}; move the string into packages/butler-i18n and pass it through app copy`,
      });
    }
  });
}

if (findings.length > 0 || localizedFindings.length > 0) {
  console.error("App client copy lint failed:");
  for (const finding of findings) {
    console.error(`packages/butler-app/client/ui/src/components/conversation/Conversation.tsx:${finding.line}: ${finding.reason}`);
    console.error(`  ${finding.text}`);
  }
  for (const finding of localizedFindings) {
    console.error(`${finding.path}:${finding.line}: ${finding.reason}`);
    console.error(`  ${finding.text}`);
  }
  process.exit(1);
}

if (verbose) console.log("App client copy lint passed for conversation turn labels and localized components.");
