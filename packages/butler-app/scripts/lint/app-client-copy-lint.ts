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

if (findings.length > 0) {
  console.error("App client copy lint failed:");
  for (const finding of findings) {
    console.error(`packages/butler-app/client/ui/src/components/conversation/Conversation.tsx:${finding.line}: ${finding.reason}`);
    console.error(`  ${finding.text}`);
  }
  process.exit(1);
}

if (verbose) console.log("App client copy lint passed for conversation turn labels.");
