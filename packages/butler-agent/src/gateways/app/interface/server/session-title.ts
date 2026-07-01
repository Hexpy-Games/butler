import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeGeneratedSessionTitle } from "../../../../agent/output/session-title.ts";
import { runPromptText } from "../../../../integrations/providers/provider.ts";
import type { CreateSessionRequest } from "../protocol/app-protocol.ts";
import type { AppServerStore } from "../../application/store/app-server-store.ts";

const SESSION_CREATE_TITLE_TIMEOUT_MS = 20_000;
const SESSION_TITLE_INSTRUCTIONS = [
  "Generate one safe chat session title.",
  "Return only the title, in the user's language.",
  "Keep it concise: normally 2 to 8 words, no quotes, no markdown, no trailing period.",
  "Do not include secrets, raw prompts, tool names, or internal ids.",
].join(" ");

export async function createSessionInputWithGeneratedTitle(input: {
  body: CreateSessionRequest;
  requestSignal?: AbortSignal;
  store: AppServerStore;
}): Promise<CreateSessionRequest> {
  const generatedTitle = await generateTitleFromInitialMessage({
    initialMessage: input.body.initial_message,
    requestSignal: input.requestSignal,
    butlerData: input.store.butlerDataRoot(),
  });
  if (!generatedTitle) return input.body;
  return {
    ...input.body,
    title: generatedTitle,
  };
}

async function generateTitleFromInitialMessage(input: {
  initialMessage?: string;
  requestSignal?: AbortSignal;
  butlerData: string;
}): Promise<string | null> {
  const boundedText = input.initialMessage
    ?.replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1200);
  if (!boundedText || input.requestSignal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SESSION_CREATE_TITLE_TIMEOUT_MS,
  );
  timeout.unref?.();
  const abort = () => controller.abort();
  input.requestSignal?.addEventListener("abort", abort, { once: true });

  try {
    const text = await runPromptText({
      prompt: `User message:\n${boundedText}`,
      model: await readConfiguredTitleModel(input.butlerData),
      instructions: SESSION_TITLE_INSTRUCTIONS,
      cacheScope: "app-session-create-title",
      signal: controller.signal,
      butlerData: input.butlerData,
    });
    if (controller.signal.aborted) return null;
    return safeGeneratedSessionTitle(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    input.requestSignal?.removeEventListener("abort", abort);
  }
}

async function readConfiguredTitleModel(
  butlerData: string,
): Promise<string | undefined> {
  try {
    const config = JSON.parse(
      await readFile(join(butlerData, "butler.config.json"), "utf8"),
    ) as Record<string, unknown>;
    const system = safeRecord(config.system);
    return safeString(system.butlerModel) ?? safeString(system.defaultModel);
  } catch {
    return undefined;
  }
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
