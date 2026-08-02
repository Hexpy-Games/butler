#!/usr/bin/env bun

import { handleNativeStewardTelegramTurn } from "../src/application/native-steward.ts";

const [, , projectName, workspacePath, message, threadId = "", chatId = ""] = process.argv;

if (!projectName || !workspacePath || !message || !chatId) {
  console.error(
    "Usage: $BUTLER_BUN run packages/butler-agent/scripts/native-steward-turn.ts <project_name> <workspace_path> <message> <thread_id> <chat_id>",
  );
  process.exit(1);
}

try {
  const result = await handleNativeStewardTelegramTurn({
    projectName,
    workspacePath,
    message,
    threadId: threadId || undefined,
    chatId,
  });
  process.stdout.write(`${result.sessionId}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
