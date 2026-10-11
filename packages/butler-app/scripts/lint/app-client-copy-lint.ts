import ts from "typescript";
import { lifecycleCopy } from "../../../butler-i18n/src/lifecycle.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
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


type Copy = ReturnType<typeof getAppCopy>;

const locales = ["en-US", "ko-KR"] as const;

/** Agent internals that the default UI must not name. */
const INTERNAL_TERMS = [/Steward/u, /Ledger/u, /원장/u, /Gateway/u, /Worker/iu, /automation/iu, /자동화/u];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function offending(texts: string[], terms: RegExp[]): string[] {
  return texts.filter((text) => terms.some((term) => term.test(text)));
}

/** Copy on screens every user sees before turning on developer mode. */
function defaultSurfaceCopy(copy: Copy): string[] {
  return strings([
    copy.inspector.tabs.summary,
    copy.inspector.tabs.artifacts,
    copy.inspector.tabs.automations,
    copy.automations.inspector.empty,
    copy.interfacePanels.progress,
    copy.interfacePanels.noProgress,
    copy.interfacePanels.noPlans,
    copy.interfacePanels.noSpecs,
    copy.composer.gitMissingTitle,
    copy.composer.gitMissingMessage,
    copy.interfaceFeedback.stewardStopFailed,
    copy.interfaceFeedback.stewardResumeFailed,
    copy.projectSignpost,
    copy.projectStatistics,
  ]);
}


for (const locale of locales) {
  for (const text of offending(defaultSurfaceCopy(getAppCopy(locale)), INTERNAL_TERMS)) {
    localizedFindings.push({ path: "packages/butler-i18n/src/locales/" + locale, line: 1, text, reason: "default surfaces must avoid agent internal names" });
  }
}
// Only this key renders the product wordmark in the setup logo lockup.
const KOREAN_WORDMARK_KEYS = new Set(["firstRun.product"]);

type CopyString = { key: string; text: string };

/** Inspect generated copy without invoking formatters with invented arguments. */
function functionStrings(value: (...args: never[]) => unknown, key: string): CopyString[] {
  const source = ts.createSourceFile("copy.ts", `(${value.toString()})`, ts.ScriptTarget.Latest, true);
  const result: CopyString[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      result.push({ key, text: node.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

function collectStrings(value: unknown, key = ""): CopyString[] {
  if (typeof value === "string") return [{ key, text: value }];
  if (typeof value === "function") return functionStrings(value as (...args: never[]) => unknown, key);
  return value && typeof value === "object"
    ? Object.entries(value).flatMap(([name, child]) => collectStrings(child, key ? `${key}.${name}` : name)) : [];
}
for (const { key, text } of [...collectStrings(getAppCopy("ko-KR")), ...collectStrings(lifecycleCopy.ko, "lifecycle")]) {
  const badGlossary = /워커|작업자|타임존|보관함|Butler App|자동화/u.test(text);
  const badProductName = /Butler/u.test(text) && !(KOREAN_WORDMARK_KEYS.has(key) && text === "Butler");
  if (!badGlossary && !badProductName) continue;
  localizedFindings.push({ path: "packages/butler-i18n/src/locales/ko.ts", line: 1, text,
    reason: `${key}: use the approved Korean glossary (버틀러, Worker, 시간대, 아카이브, 예약 작업); Butler is reserved for wordmarks` });
}
for (const { text } of collectStrings(getAppCopy("en-US"))) {
  if (!/\bautomations?\b|\bscheduled tasks?\b/iu.test(text)) continue;
  localizedFindings.push({ path: "packages/butler-i18n/src/locales/en.ts", line: 1, text, reason: "use schedule for the scheduled-run feature" });
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
