import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  accountIdFromAccessToken,
  buildOpenAIAuthorizeUrl,
  getOpenAIOAuthClientId,
  pkceChallenge,
  resolveOpenAIAuth,
  writeButlerOpenAIAuthProfile,
} from "../../packages/butler-agent/src/integrations/providers/openai/auth.ts";
import {
  AUTO_CODEX_LATEST,
  pickLatestCodexModel,
  resolveDynamicOpenAIModel,
} from "../../packages/butler-agent/src/integrations/providers/openai/models.ts";
import {
  extractResponseText,
  isTransientModelApiError,
  runFunctionToolPromptText,
  runPromptText,
  runShellTask,
} from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import {
  ModelProviderRequestError,
  providerHttpError,
  safeRuntimeFailure,
  type RuntimeFailureDiagnostic,
} from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  normalizeLocalServerUrl,
  safeLocalModelId,
} from "../../packages/butler-agent/src/integrations/providers/local/models.ts";
import {
  registerHostedModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import {
  readPromptCacheMetrics,
} from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import {
  resolveRuntimeMessageLanguage,
  runtimeMessages,
} from "../../packages/butler-agent/src/agent/output/messages.ts";
import { isToolBatchCompletedHandoffText } from "../../packages/butler-agent/src/agent/model-tool-loop/index.ts";
import {
  isContainerRuntime,
  resolveOAuthListenHost,
  resolveOAuthPort,
  resolveOAuthRedirectUri,
  shouldAttemptBrowserOpen,
} from "../../packages/butler-agent/scripts/openai-oauth-login.ts";

let tempDir = "";
let originalFetch: typeof fetch;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-openai-auth-"));
  originalFetch = globalThis.fetch;
  process.env.BUTLER_DATA = tempDir;
  delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
  delete process.env.BUTLER_CODEX_AUTH_PROFILE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_AUTH_JSON;
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.BUTLER_CODEX_BASE_URL;
  delete process.env.BUTLER_CODEX_USER_AGENT;
  delete process.env.BUTLER_CODEX_OAUTH_CLIENT_ID;
  delete process.env.BUTLER_OPENAI_OAUTH_CLIENT_ID;
  delete process.env.BUTLER_CODEX_OAUTH_PORT;
  delete process.env.BUTLER_OPENAI_OAUTH_PORT;
  delete process.env.BUTLER_CODEX_OAUTH_REDIRECT_URI;
  delete process.env.BUTLER_OPENAI_OAUTH_REDIRECT_URI;
  delete process.env.BUTLER_CODEX_OAUTH_LISTEN_HOST;
  delete process.env.BUTLER_OPENAI_OAUTH_LISTEN_HOST;
  delete process.env.BUTLER_CODEX_OAUTH_NO_BROWSER;
  delete process.env.BUTLER_OPENAI_OAUTH_NO_BROWSER;
  delete process.env.BUTLER_CODEX_OAUTH_ORIGINATOR;
  delete process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR;
  delete process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  delete process.env.BUTLER_MODEL_API_RETRY_DELAY_MS;
  delete process.env.BUTLER_RUNTIME;
  delete process.env.BUTLER_XAI_BASE_URL;
  delete process.env.BUTLER_ANTHROPIC_BASE_URL;
  delete process.env.BUTLER_GOOGLE_BASE_URL;
  delete process.env.BUTLER_ZAI_BASE_URL;
  delete process.env.BUTLER_OPENCODE_GO_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.BUTLER_DATA;
  delete process.env.BUTLER_RUNTIME;
  delete process.env.BUTLER_OPENCODE_GO_BASE_URL;
});

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function finalEnvelope(text: string): string {
  return `<butler_final_answer>\n${text}\n</butler_final_answer>`;
}

function codexSseResponse(input: {
  id: string;
  item: Record<string, unknown>;
  inputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}): Response {
  return new Response([
    `data: ${JSON.stringify({ type: "response.output_item.done", item: input.item })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: input.id,
        status: "completed",
        usage: {
          input_tokens: input.inputTokens,
          total_tokens: input.totalTokens,
          input_tokens_details: { cached_tokens: input.cachedTokens ?? 0 },
        },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n"), { status: 200 });
}

test("OpenAI response text extraction strips Butler final-answer envelope", () => {
  const text = extractResponseText({
    id: "resp-final-envelope",
    output_text: [
      "draft that must not be delivered",
      "<butler_final_answer>",
      "Final user-facing answer.",
      "</butler_final_answer>",
      "Sources outside the envelope must not leak.",
    ].join("\n"),
  } as any);

  expect(text).toBe("Final user-facing answer.");
});

test("provider HTTP context overflow is classified as context limit", () => {
  const error = providerHttpError({
    provider: "local",
    api: "chat_completions",
    statusCode: 400,
    detail: "request (33981 tokens) exceeds the available context size (32768 tokens), try increasing it",
    model: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
  });

  expect(error.diagnostic()).toMatchObject({
    code: "provider_context_limit_exceeded",
    provider: "local",
    api: "chat_completions",
    statusCode: 400,
    retryable: true,
    model: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
  });
  expect(error.message).toContain("context limit");
});

async function captureProviderError(action: () => Promise<unknown>): Promise<RuntimeFailureDiagnostic> {
  try {
    await action();
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderRequestError);
    return safeRuntimeFailure(error);
  }
}

test("PKCE authorize URL uses S256 challenge and preserves caller state", () => {
  const verifier = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~";
  const url = new URL(buildOpenAIAuthorizeUrl({
    clientId: "client_123",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    codeChallenge: pkceChallenge(verifier),
    state: "state_abc",
    scope: "openid profile",
  }));

  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe("client_123");
  expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
  expect(url.searchParams.get("state")).toBe("state_abc");
  expect(url.searchParams.get("scope")).toBe("openid profile");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toHaveLength(43);
  expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
  expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  expect(url.searchParams.get("originator")).toBe("butler");
  expect(getOpenAIOAuthClientId()).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
});

test("OAuth login callback keeps host-facing localhost redirect while Docker can listen on published ports", () => {
  expect(resolveOAuthPort({})).toBe(1455);
  expect(resolveOAuthPort({ BUTLER_CODEX_OAUTH_PORT: "1777" })).toBe(1777);
  expect(resolveOAuthRedirectUri(1455, {})).toBe("http://localhost:1455/auth/callback");
  expect(resolveOAuthRedirectUri(1455, {
    BUTLER_CODEX_OAUTH_REDIRECT_URI: "http://localhost:1777/auth/callback",
  })).toBe("http://localhost:1777/auth/callback");
  expect(resolveOAuthListenHost({ BUTLER_CODEX_OAUTH_LISTEN_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  expect(isContainerRuntime((path) => path === "/.dockerenv")).toBe(true);
});

test("OAuth login does not pretend to open a browser in headless Linux containers", () => {
  expect(shouldAttemptBrowserOpen({}, "linux")).toBe(false);
  expect(shouldAttemptBrowserOpen({ DISPLAY: ":0" }, "linux")).toBe(true);
  expect(shouldAttemptBrowserOpen({ BUTLER_CODEX_OAUTH_NO_BROWSER: "1", DISPLAY: ":0" }, "linux")).toBe(false);
  expect(shouldAttemptBrowserOpen({}, "darwin")).toBe(true);
});

test("Codex subscription account id prefers ChatGPT account id claim", () => {
  const token = fakeJwt({
    sub: "subject-id",
    "https://api.openai.com/auth": {
      account_id: "platform-account",
      chatgpt_account_id: "chatgpt-account",
    },
  });

  expect(accountIdFromAccessToken(token)).toBe("chatgpt-account");
});

test("auth resolution prefers API key, then Codex subscription profile", async () => {
  process.env.OPENAI_API_KEY = "api-key";
  expect(await resolveOpenAIAuth()).toMatchObject({
    mode: "api_key",
    authorization: "Bearer api-key",
  });

  delete process.env.OPENAI_API_KEY;
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: "profile-token",
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  expect(await resolveOpenAIAuth()).toMatchObject({
    mode: "codex_subscription",
    authorization: "Bearer profile-token",
  });
});

test("latest Codex model picker prefers newest non-mini Codex-family model", () => {
  expect(pickLatestCodexModel([
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "gpt-5-codex",
    "gpt-5.5-codex",
    "gpt-5.4-codex-mini",
  ])).toBe("gpt-5.6-sol");
  expect(() => pickLatestCodexModel(["gpt-5.4", "gpt-5.5"])).toThrow(/No Codex-capable OpenAI model/u);
});

test("auto Codex latest resolves through /v1/models and fails closed offline", async () => {
  process.env.OPENAI_API_KEY = "token";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { id: "gpt-5.6-terra" },
      { id: "gpt-5.6-sol" },
      { id: "gpt-5.5-codex" },
    ],
  }), { status: 200 })) as unknown as typeof fetch;

  expect(await resolveDynamicOpenAIModel(AUTO_CODEX_LATEST)).toBe("gpt-5.6-sol");
  expect(await resolveDynamicOpenAIModel("gpt-5.4")).toBe("gpt-5.4");

  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(resolveDynamicOpenAIModel(AUTO_CODEX_LATEST)).rejects.toThrow(/could not be resolved/u);
});

test("default OpenAI model is concrete and does not require model discovery", async () => {
  process.env.OPENAI_API_KEY = "token";

  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).not.toContain("/models");
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      id: "resp_default_model",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "ok" }],
      }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({ prompt: "hi" })).resolves.toBe("ok");
  expect(seenBody.model).toBe("gpt-5.5-codex");
});

test("registered OpenAI hosted prompt forwards response format", async () => {
  registerHostedModelConfig({
    providerId: "openai",
    modelId: "gpt-5.5",
    authType: "api_key",
    apiKey: "registered-openai-secret",
  }, tempDir);

  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenUrl = String(input);
    seenAuthorization = String(new Headers(init?.headers).get("authorization"));
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      id: "resp_registered_openai_format",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "{\"ok\":\"yes\"}" }],
      }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const responseFormat = {
    type: "json_schema" as const,
    name: "registered_openai_json_gate",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "string" } },
    },
  };

  await expect(runPromptText({
    model: "openai/gpt-5.5",
    prompt: "hi",
    responseFormat,
  })).resolves.toBe("{\"ok\":\"yes\"}");
  expect(seenUrl).toContain("/responses");
  expect(seenAuthorization).toBe("Bearer registered-openai-secret");
  expect(seenBody.text).toEqual({ format: responseFormat });
});

test("registered xAI model uses stored credential through OpenAI-compatible adapter", async () => {
  registerHostedModelConfig({
    providerId: "xai",
    modelId: "grok-4.3",
    authType: "api_key",
    apiKey: "xai-secret-key",
    credentialLabel: "xAI test key",
  }, tempDir);

  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenUrl = String(input);
    seenAuthorization = String(new Headers(init?.headers).get("authorization"));
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hello from grok" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "xai/grok-4.3",
    prompt: "hi",
  })).resolves.toBe("hello from grok");
  expect(seenUrl).toBe("https://api.x.ai/v1/chat/completions");
  expect(seenAuthorization).toBe("Bearer xai-secret-key");
  expect(seenBody.model).toBe("grok-4.3");
  expect(seenBody.messages).toContainEqual({ role: "user", content: "hi" });
});

test("registered OpenAI-compatible hosted model executes tool calls", async () => {
  registerHostedModelConfig({
    providerId: "xai",
    modelId: "grok-4.3",
    authType: "api_key",
    apiKey: "xai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"butler\"}",
              },
            }],
          },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "tool result used" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const text = await runFunctionToolPromptText({
    model: "xai/grok-4.3",
    prompt: "search",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async (call) => {
      expect(call).toMatchObject({
        name: "lookup",
        args: { query: "butler" },
      });
      return { answer: "found" };
    },
  });

  expect(text).toBe("tool result used");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.messages).toContainEqual(
    expect.objectContaining({
      role: "tool",
      tool_call_id: "call_1",
      name: "lookup",
    }),
  );
});

test("registered Z.AI hosted tool calls forward reasoning effort", async () => {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  const attributedRequests: number[] = [];
  const attributedUsage: number[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"butler\"}",
              },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "tool result used" } }],
      usage: { prompt_tokens: 140, completion_tokens: 10, total_tokens: 150 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runFunctionToolPromptText({
    model: "zai/glm-5.2",
    reasoningEffort: "low",
    prompt: "search",
    butlerData: tempDir,
    usageAttribution: {
      turnId: "turn-zai-tools",
      phase: "initial_tool_loop",
      budgetState: { status: "ok", requestCount: 0, maxRequests: 8 },
      beforeModelRequest: ({ roundIndex }) => attributedRequests.push(roundIndex),
      afterModelResponseUsage: (usage) => attributedUsage.push(usage.promptTokens ?? 0),
    },
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async () => ({ answer: "found" }),
  })).resolves.toBe("tool result used");

  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.reasoning_effort).toBe("low");
  expect(bodies[1]!.reasoning_effort).toBe("low");
  expect(attributedRequests).toEqual([0, 1]);
  expect(attributedUsage).toEqual([100, 140]);
});

test("registered Z.AI adapter keeps consecutive decisions and tool results in one provider loop", async () => {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  const decisions: string[] = [];
  const executed: string[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    if (bodies.length <= 2) {
      const index = bodies.length;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: index === 1
              ? ""
              : [
                "title: 두 번째 상태 확인",
                "summary: 첫 결과를 바탕으로 두 번째 상태를 확인합니다.",
                "rationale: 두 상태를 함께 관찰해야 다음 행동을 정할 수 있습니다.",
                "next_step: 두 결과를 비교해 결론을 작성합니다.",
              ].join("\n"),
            tool_calls: [{
              id: `call_${index}`,
              type: "function",
              function: {
                name: "lookup",
                arguments: JSON.stringify({ query: `butler-${index}` }),
              },
            }],
          },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "both results observed" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const text = await runFunctionToolPromptText({
    model: "zai/glm-5.2",
    prompt: "inspect two states",
    maxToolRounds: 4,
    handoffAfterToolBatch: false,
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    onAssistantTextBeforeTools: ({ text }) => {
      decisions.push(text);
    },
    executeTool: async (call) => {
      executed.push(String(call.args.query));
      return { answer: call.args.query };
    },
  });

  expect(text).toBe("both results observed");
  expect(executed).toEqual(["butler-1", "butler-2"]);
  expect(decisions).toHaveLength(2);
  expect(bodies).toHaveLength(3);
  expect(bodies[1]!.messages).toContainEqual(expect.objectContaining({
    role: "tool",
    tool_call_id: "call_1",
  }));
  expect(bodies[2]!.messages).toContainEqual(expect.objectContaining({
    role: "tool",
    tool_call_id: "call_2",
  }));
});

test("registered Z.AI typed tool batches hand off before hidden final synthesis", async () => {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(init?.body || "{}")));
    if (bodies.length > 1) throw new Error("unexpected hidden synthesis request");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: "summary: 후보를 검색합니다.",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{\"query\":\"butler\"}",
            },
          }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const text = await runFunctionToolPromptText({
    model: "zai/glm-5.2",
    prompt: "search",
    maxToolRounds: 1,
    handoffAfterToolBatch: true,
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async () => ({ answer: "found" }),
  });

  expect(isToolBatchCompletedHandoffText(text)).toBe(true);
  expect(bodies).toHaveLength(1);
});

test("registered Z.AI hosted tool result preserves exact structured payload", async () => {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_large",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"butler\"}",
              },
            }],
          },
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "tool result used" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runFunctionToolPromptText({
    model: "zai/glm-5.2",
    reasoningEffort: "low",
    prompt: "search",
    butlerData: tempDir,
    usageAttribution: { turnId: "turn-hosted-evidence" },
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async () => ({
      ok: true,
      title: "Large hosted tool result",
      stdout: [
        "HEAD_START",
        "A".repeat(16_000),
        "RAW_MIDDLE_ONLY_IN_HOSTED_ARTIFACT",
        "B".repeat(16_000),
        "TAIL_END",
      ].join("\n"),
    }),
  })).resolves.toBe("tool result used");

  expect(bodies).toHaveLength(2);
  const toolMessage = bodies[1]!.messages.find((message: Record<string, unknown>) => message.role === "tool");
  const content = String(toolMessage.content);
  expect(content).toContain("RAW_MIDDLE_ONLY_IN_HOSTED_ARTIFACT");
  const parsed = JSON.parse(content) as Record<string, any>;
  expect(parsed).toMatchObject({
    ok: true,
    output: { ok: true, title: "Large hosted tool result" },
  });
  expect(content).not.toContain("completed-tool-evidence");
  expect(content).not.toContain("evidence_packet");
});

test("registered Z.AI preserves every completed tool result exactly", async () => {
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: Array.from({ length: 5 }, (_, index) => ({
            id: `call_old_${index}`,
            type: "function",
            function: { name: "lookup", arguments: JSON.stringify({ query: `old-${index}` }) },
          })),
        } }],
      }), { status: 200 });
    }
    if (bodies.length === 2) {
      return new Response(JSON.stringify({
        choices: [{ message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_latest",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"latest\"}" },
          }],
        } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "rolling context used" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runFunctionToolPromptText({
    model: "zai/glm-5.2",
    prompt: "inspect several bounded results",
    butlerData: tempDir,
    maxToolRounds: 3,
    usageAttribution: { turnId: "turn-hosted-rolling-context" },
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a term.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async (call) => call.args.query === "latest"
      ? { ok: true, title: "Latest result", message: "LATEST_RAW_RESULT" }
      : { ok: true, title: String(call.args.query), message: "OLD_RAW_RESULT_".repeat(300) },
  })).resolves.toBe("rolling context used");

  expect(bodies).toHaveLength(3);
  const secondRequest = JSON.stringify(bodies[1]!.messages);
  const thirdRequest = JSON.stringify(bodies[2]!.messages);
  expect(secondRequest).toContain("OLD_RAW_RESULT_".repeat(50));
  expect(thirdRequest).toContain("OLD_RAW_RESULT_".repeat(50));
  expect(secondRequest).not.toContain("completed-tool-evidence");
  expect(thirdRequest).not.toContain("evidence_packet");
  expect(thirdRequest).toContain("Latest result");
});

test("registered Anthropic and Gemini models use provider-native API keys", async () => {
  registerHostedModelConfig({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    authType: "api_key",
    apiKey: "anthropic-secret",
  }, tempDir);
  registerHostedModelConfig({
    providerId: "google",
    modelId: "gemini-3.5-flash",
    authType: "api_key",
    apiKey: "gemini-secret",
  }, tempDir);

  const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url, headers, body });
    if (url.includes("anthropic")) {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "claude ok" }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "gemini ok" }] } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "anthropic/claude-sonnet-4-6",
    prompt: "hi",
  })).resolves.toBe("claude ok");
  await expect(runPromptText({
    model: "google/gemini-3.5-flash",
    prompt: "hi",
  })).resolves.toBe("gemini ok");

  expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  expect(calls[0]!.headers.get("x-api-key")).toBe("anthropic-secret");
  expect(calls[0]!.body.model).toBe("claude-sonnet-4-6");
  expect(calls[1]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
  expect(calls[1]!.headers.get("x-goog-api-key")).toBe("gemini-secret");
});

test("registered Qwen Kimi and Z.AI models use their OpenAI-compatible endpoints", async () => {
  registerHostedModelConfig({
    providerId: "qwen",
    modelId: "qwen3.7-max",
    authType: "api_key",
    apiKey: "qwen-secret",
  }, tempDir);
  registerHostedModelConfig({
    providerId: "kimi",
    modelId: "kimi-k2.6",
    authType: "api_key",
    apiKey: "kimi-secret",
  }, tempDir);
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret",
  }, tempDir);

  const calls: Array<{ url: string; authorization: string; body: Record<string, any> }> = [];
  const attributedRequests: number[] = [];
  const attributedUsage: unknown[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      authorization: String(new Headers(init?.headers).get("authorization")),
      body: JSON.parse(String(init?.body || "{}")),
    });
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "qwen/qwen3.7-max",
    prompt: "hi",
  })).resolves.toBe("ok");
  await expect(runPromptText({
    model: "kimi/kimi-k2.6",
    prompt: "hi",
  })).resolves.toBe("ok");
  await expect(runPromptText({
    model: "zai/glm-5.2",
    prompt: "hi",
    reasoningEffort: "low",
    responseFormat: {
      type: "json_schema",
      name: "hosted_json_gate",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "string" } },
      },
    },
    butlerData: tempDir,
    cacheScope: "hosted-zai-test",
    usageAttribution: {
      turnId: "turn-zai-usage",
      phase: "typed_turn_decision",
      budgetState: { status: "ok", requestCount: 0, maxRequests: 8 },
      beforeModelRequest: ({ roundIndex }) => attributedRequests.push(roundIndex),
      afterModelResponseUsage: (usage) => attributedUsage.push(usage),
    },
  })).resolves.toBe("ok");

  expect(calls[0]!).toMatchObject({
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    authorization: "Bearer qwen-secret",
  });
  expect(calls[0]!.body.model).toBe("qwen3.7-max");
  expect(calls[1]!).toMatchObject({
    url: "https://api.moonshot.ai/v1/chat/completions",
    authorization: "Bearer kimi-secret",
  });
  expect(calls[1]!.body.model).toBe("kimi-k2.6");
  expect(calls[2]!).toMatchObject({
    url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    authorization: "Bearer zai-secret",
  });
  expect(calls[2]!.body.model).toBe("glm-5.2");
  expect(calls[2]!.body.reasoning_effort).toBe("low");
  expect(calls[2]!.body.response_format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "hosted_json_gate",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "string" } },
      },
    },
  });
  expect(attributedRequests).toEqual([0]);
  expect(attributedUsage).toEqual([expect.objectContaining({
    model: "zai/glm-5.2",
    promptTokens: 120,
    cachedTokens: 80,
    outputTokens: 30,
    totalTokens: 150,
    roundIndex: 0,
  })]);
  expect(readPromptCacheMetrics({ butlerData: tempDir })).toContainEqual(expect.objectContaining({
    model: "zai/glm-5.2",
    scope: "hosted-zai-test",
    turnId: "turn-zai-usage",
    phase: "typed_turn_decision",
    promptTokens: 120,
    cachedTokens: 80,
  }));
});

test("registered OpenCode Go chat-completions models use the hosted OpenAI-compatible endpoint", async () => {
  registerHostedModelConfig({
    providerId: "opencode-go",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "opencode-go-secret",
  }, tempDir);

  let seenUrl = "";
  let seenAuthorization = "";
  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenUrl = String(input);
    seenAuthorization = String(new Headers(init?.headers).get("authorization"));
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "glm ok" } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "opencode-go/glm-5.2",
    prompt: "hi",
  })).resolves.toBe("glm ok");

  expect(seenUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  expect(seenAuthorization).toBe("Bearer opencode-go-secret");
  expect(seenBody.model).toBe("glm-5.2");
  expect(seenBody.messages).toContainEqual({ role: "user", content: "hi" });
});

test("registered OpenCode Go messages models use the hosted Anthropic-compatible endpoint", async () => {
  registerHostedModelConfig({
    providerId: "opencode-go",
    modelId: "minimax-m3",
    authType: "api_key",
    apiKey: "opencode-go-message-secret",
  }, tempDir);

  let seenUrl = "";
  let seenApiKey = "";
  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenUrl = String(input);
    const headers = new Headers(init?.headers);
    seenApiKey = String(headers.get("x-api-key"));
    seenBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "minimax ok" }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "opencode-go/minimax-m3",
    prompt: "hi",
  })).resolves.toBe("minimax ok");

  expect(seenUrl).toBe("https://opencode.ai/zen/go/v1/messages");
  expect(seenApiKey).toBe("opencode-go-message-secret");
  expect(seenBody.model).toBe("minimax-m3");
  expect(seenBody.messages).toContainEqual({ role: "user", content: "hi" });
});

test("model API calls retry transient backend failures without caller rework", async () => {
  process.env.OPENAI_API_KEY = "token";
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";
  process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = "0";

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response(JSON.stringify({
        error: { message: "temporary server_error" },
      }), { status: 503 });
    }
    return new Response(JSON.stringify({
      id: "resp_retry",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "recovered" }],
      }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({ model: "gpt-5.5", prompt: "hi" })).resolves.toBe("recovered");
  expect(attempts).toBe(3);
  expect(isTransientModelApiError(new Error("Codex backend error (503): upstream connect error"))).toBe(true);
  expect(isTransientModelApiError(new Error("OpenAI Responses API error (400): bad request"))).toBe(false);
});

test("hosted chat adapters use the same transient retry policy", async () => {
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";
  process.env.BUTLER_MODEL_API_RETRY_DELAY_MS = "0";
  registerHostedModelConfig({
    providerId: "zai",
    modelId: "glm-5.2",
    authType: "api_key",
    apiKey: "zai-secret-key",
  }, tempDir);

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("fetch failed: ETIMEDOUT");
    return Response.json({
      choices: [{ message: { role: "assistant", content: "hosted recovered" } }],
    });
  }) as unknown as typeof fetch;

  await expect(runPromptText({ model: "zai/glm-5.2", prompt: "hi" }))
    .resolves.toBe("hosted recovered");
  expect(attempts).toBe(3);
});

test("provider HTTP failures preserve safe status diagnostics", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "1";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      error: { message: "upstream exploded with token=secret" },
    }), { status: 500 })) as unknown as typeof fetch;

  try {
    await runPromptText({ model: "gpt-5.5", prompt: "hi" });
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderRequestError);
    const diagnostic = safeRuntimeFailure(error);
    expect(diagnostic).toMatchObject({
      code: "provider_api_error",
      provider: "openai",
      api: "responses",
      statusCode: 500,
      retryable: true,
      model: "gpt-5.5",
    });
    expect(diagnostic.message).toContain("HTTP 500");
    expect(diagnostic.endpoint).toContain("/v1/responses");
    expect(diagnostic.cause).toContain("[redacted]");
    expect(diagnostic.cause).not.toContain("token=secret");
  }
});

test("provider network failures preserve safe connection diagnostics", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "1";
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed: ENOTFOUND api.openai.com");
  }) as unknown as typeof fetch;

  try {
    await runPromptText({ model: "gpt-5.5", prompt: "hi" });
    throw new Error("expected provider network failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderRequestError);
    const diagnostic = safeRuntimeFailure(error);
    expect(diagnostic).toMatchObject({
      code: "provider_network_error",
      provider: "openai",
      api: "responses",
      retryable: true,
      model: "gpt-5.5",
    });
    expect(diagnostic.message).toContain("connection failed");
    expect(diagnostic.cause).toContain("ENOTFOUND");
  }
});

test("registered local OpenAI-compatible model handles text prompts", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (_request) => {
      const body = await _request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "local hello",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-local");

  try {
    await expect(runPromptText({
      model: "local/gemma-local",
      instructions: "Be concise.",
      prompt: "hi",
    })).resolves.toBe("local hello");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({
      model: "gemma-local",
      stream: false,
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hi" },
      ],
    });
  } finally {
    localServer.stop(true);
  }
});

test("local llama.cpp reasoning budget ratio sends per-request thinking budget tokens", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "reasoned",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-reasoning", { reasoningBudgetRatio: 0.25 });

  try {
    const text = await runPromptText({
      model: "local/gemma-reasoning",
      instructions: "Be concise.",
      prompt: "think briefly",
    });

    expect(text).toBe("reasoned");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.thinking_budget_tokens).toBe(1_024);
    expect(seenBodies[0]?.temperature).toBe(0);
    expect(seenBodies[0]?.max_tokens).toBe(4_096);
  } finally {
    localServer.stop(true);
  }
});

test("registered local model strips hidden reasoning from visible text", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "<think>private chain of thought</think>",
            "<|channel|final|>",
            "Visible answer only.",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-hidden-reasoning");

  try {
    await expect(runPromptText({
      model: "local/gemma-hidden-reasoning",
      prompt: "hi",
    })).resolves.toBe("Visible answer only.");
  } finally {
    localServer.stop(true);
  }
});

test("registered local model keeps ordinary final labels and code fences visible", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "Summary",
            "",
            "Final:",
            "```text",
            "<think>literal example</think>",
            "```",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-final-label");

  try {
    await expect(runPromptText({
      model: "local/gemma-final-label",
      prompt: "show example",
    })).resolves.toBe([
      "Summary",
      "",
      "Final:",
      "```text",
      "<think>literal example</think>",
      "```",
    ].join("\n"));
  } finally {
    localServer.stop(true);
  }
});

test("registered local model strips textual analysis protocol before final", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "analysis:",
            "private scratchpad",
            "final:",
            "Visible answer.",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-text-protocol");

  try {
    await expect(runPromptText({
      model: "local/gemma-text-protocol",
      prompt: "hi",
    })).resolves.toBe("Visible answer.");
  } finally {
    localServer.stop(true);
  }
});

test("registered local OpenAI-compatible model receives image attachments as OpenAI-compatible image parts", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (_request) => {
      const body = await _request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "image seen",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-vision");
  const fileId = "file-00000000-0000-4000-8000-000000000001";
  mkdirSync(join(tempDir, "app-server", "message-files"), { recursive: true });
  writeFileSync(join(tempDir, "app-server", "message-files", fileId), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  try {
    await expect(runPromptText({
      model: "local/gemma-vision",
      prompt: "describe this",
      attachments: [{
        id: fileId,
        kind: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        sizeBytes: 8,
        url: `/message-files/${fileId}`,
      }],
    })).resolves.toBe("image seen");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.messages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("describe this"),
      }),
      expect.objectContaining({
        type: "image_url",
        image_url: {
          url: expect.stringMatching(/^data:image\/png;base64,/),
        },
      }),
    ]);
    expect(JSON.stringify(seenBodies[0])).not.toContain(tempDir);
  } finally {
    localServer.stop(true);
  }
});

test("text attachments include bounded document content in model prompt", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (_request) => {
      const body = await _request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "document seen",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-docs");
  const fileId = "file-00000000-0000-4000-8000-000000000002";
  mkdirSync(join(tempDir, "app-server", "message-files"), { recursive: true });
  writeFileSync(
    join(tempDir, "app-server", "message-files", fileId),
    "# Attached Draft\n\nUnique attached markdown body.",
  );

  try {
    await expect(runPromptText({
      model: "local/gemma-docs",
      prompt: "summarize the attachment",
      attachments: [{
        id: fileId,
        kind: "document",
        mimeType: "text/markdown",
        fileName: "draft.md",
        sizeBytes: 46,
        url: `/message-files/${fileId}`,
      }],
    })).resolves.toBe("document seen");

    const content = seenBodies[0]?.messages[0]?.content;
    expect(typeof content).toBe("string");
    expect(content).toContain("summarize the attachment");
    expect(content).toContain("draft.md");
    expect(content).toContain("Unique attached markdown body.");
    expect(JSON.stringify(seenBodies[0])).not.toContain(tempDir);
  } finally {
    localServer.stop(true);
  }
});

test("local model URL and id normalization rejects ambiguous unsafe inputs", () => {
  expect(normalizeLocalServerUrl("127.0.0.1:8080")).toMatchObject({
    serverUrl: "http://127.0.0.1:8080",
    apiBaseUrl: "http://127.0.0.1:8080/v1",
  });
  expect(() => normalizeLocalServerUrl("http://user:pass@127.0.0.1:8080")).toThrow("must not include credentials");
  expect(() => normalizeLocalServerUrl("http://127.0.0.1@evil.example")).toThrow("must not include credentials");

  const modelId = safeLocalModelId("local/../family\\gemma 4/model.gguf");
  expect(modelId).not.toContain("/");
  expect(modelId).not.toContain("\\");
  expect(modelId).toBe("..-family-gemma-4-model.gguf");
});

test("registered local OpenAI-compatible model handles function tool continuations", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"status\"}",
                },
              }],
            },
          }],
        });
      }
      if (!Array.isArray(body.tools)) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("done locally"),
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "done locally",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-tools");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-tools",
      prompt: "check",
      tools: [{
        type: "function",
        name: "lookup",
        description: "lookup status",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async (call) => ({
        ok: true,
        echo: call.args.query,
      }),
    });

    expect(result).toBe("done locally");
    expect(seenBodies).toHaveLength(3);
    const firstSystemMessage = String(seenBodies[0]!.messages[0].content);
    expect(seenBodies[0]!.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("use only the structured tool-call channel"),
    });
    expect(firstSystemMessage).toContain("choose and call the appropriate tool");
    expect(firstSystemMessage).toContain("Do not ask the user to name the tool");
    expect(seenBodies[0]!.tools[0]).toMatchObject({
      type: "function",
      function: { name: "lookup" },
    });
    expect(seenBodies[1]!.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_1",
      name: "lookup",
      content: expect.stringContaining("\"ok\":true"),
    }));
    expect(seenBodies[2]!.tools).toBeUndefined();
    expect(seenBodies[2]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("<butler_final_answer>"),
    });
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompt stops on terminal tool result", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length > 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "stale continuation should not run",
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_report",
              type: "function",
              function: {
                name: "write_planned_public_report",
                arguments: "{\"task_id\":\"planned-local\",\"report\":\"검토된 공개 보고입니다.\"}",
              },
            }],
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-terminal-tool-result");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-terminal-tool-result",
      prompt: "review planned worker result",
      tools: [{
        type: "function",
        name: "write_planned_public_report",
        description: "write the reviewed public report",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string" },
            report: { type: "string" },
          },
          required: ["task_id", "report"],
        },
      }],
      executeTool: async () => ({
        ok: true,
        task_id: "planned-local",
        status: "PUBLIC_REPORT_READY",
        report: "검토된 공개 보고입니다.",
      }),
      finalTextFromToolResult: ({ output }) => {
        if (!output || typeof output !== "object") return null;
        const report = (output as Record<string, unknown>).report;
        return typeof report === "string" ? report : null;
      },
    });

    expect(result).toBe("검토된 공개 보고입니다.");
    expect(seenBodies).toHaveLength(1);
  } finally {
    localServer.stop(true);
  }
});

test("registered local OpenAI-compatible model recovers empty post-tool replies with final synthesis", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"festival\"}",
                },
              }],
            },
          }],
        });
      }
      if (seenBodies.length === 2) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: finalEnvelope("final after tool evidence"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-empty-post-tool");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-empty-post-tool",
      prompt: "check",
      tools: [{
        type: "function",
        name: "lookup",
        description: "lookup status",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async (call) => ({
        ok: true,
        echo: call.args.query,
      }),
    });

    expect(result).toBe("final after tool evidence");
    expect(seenBodies).toHaveLength(3);
    expect(seenBodies[1]!.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_1",
    }));
    expect(seenBodies[2]!.tools).toBeUndefined();
    expect(seenBodies[2]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("Do not call any more tools"),
    });
  } finally {
    localServer.stop(true);
  }
});

test("registered local OpenAI-compatible model strips post-tool draft text through final envelope synthesis", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"population\"}",
                },
              }],
            },
          }],
        });
      }
      if (seenBodies.length === 2) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: [
                "Let me refine the result before answering.",
                "",
                "## Draft report",
                "This draft should not be delivered.",
              ].join("\n"),
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "prelude that must be ignored",
              "<butler_final_answer>",
              "## Final report",
              "",
              "Only this user-facing report should be delivered.",
              "</butler_final_answer>",
              "trailing draft that must be ignored",
            ].join("\n"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-post-tool-final-envelope");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-post-tool-final-envelope",
      prompt: "check",
      tools: [{
        type: "function",
        name: "lookup",
        description: "lookup status",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async (call) => ({
        ok: true,
        echo: call.args.query,
      }),
    });

    expect(result).toBe([
      "## Final report",
      "",
      "Only this user-facing report should be delivered.",
    ].join("\n"));
    expect(result).not.toContain("Let me refine");
    expect(result).not.toContain("prelude");
    expect(result).not.toContain("trailing draft");
    expect(seenBodies).toHaveLength(3);
    expect(seenBodies[2]!.tools).toBeUndefined();
    expect(seenBodies[2]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("<butler_final_answer>"),
    });
  } finally {
    localServer.stop(true);
  }
});

test("registered local OpenAI-compatible model fails closed when final synthesis omits the required envelope", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"status\"}",
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "draft or final text without the required envelope",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-post-tool-missing-envelope");

  try {
    const diagnostic = await captureProviderError(() =>
      runFunctionToolPromptText({
        model: "local/gemma-post-tool-missing-envelope",
        prompt: "check",
        tools: [{
          type: "function",
          name: "lookup",
          description: "lookup status",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        }],
        executeTool: async () => ({ ok: true }),
      }));
    expect(diagnostic).toMatchObject({
      code: "provider_empty_response",
      provider: "local",
      api: "chat_completions",
      model: "gemma-post-tool-missing-envelope",
      retryable: true,
    });
    expect(seenBodies).toHaveLength(4);
    expect(seenBodies[3]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("required final-answer envelope"),
    });
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts do not execute standalone function-call-looking text", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  let executed = false;
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          data: [{
            id: "gemma-standalone-call",
          }],
        });
      }

      const body = await request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: [
              "Example only:",
              "```python",
              "web_search(query=\"status source\")",
              "```",
            ].join("\n"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-standalone-call");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-standalone-call",
      prompt: "show sample code",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async () => {
        executed = true;
        return { ok: true };
      },
    });

    expect(executed).toBe(false);
    expect(result).toContain("web_search(query=\"status source\")");
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]!.tools).toEqual(expect.any(Array));
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts repair standalone pseudo tool calls through structured calls", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const executedCalls: Array<Record<string, unknown>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          data: [{ id: "gemma-pseudo-repair" }],
        });
      }

      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: [
                "summary: 공개 정보를 검색하겠습니다.",
                "rationale: 최신 정보를 확인해야 합니다.",
                "",
                "`web_search(query=\"status source\")`",
              ].join("\n"),
            },
          }],
        });
      }
      if (seenBodies.length === 2) {
        expect(body.messages.at(-1)).toMatchObject({
          role: "user",
          content: expect.stringContaining("has not been executed"),
        });
        expect(body.tool_choice).toBe("required");
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0]?.function?.name).toBe("web_search");
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_structured",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: "{\"query\":\"status source\"}",
                },
              }],
            },
          }],
        });
      }
      if (Array.isArray(body.tools)) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "draft from evidence",
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: finalEnvelope("verified from structured tool"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-pseudo-repair");

  try {
    const logs: string[] = [];
    const result = await runFunctionToolPromptText({
      model: "local/gemma-pseudo-repair",
      prompt: "find current status",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      log: (line) => logs.push(line),
      executeTool: async (call) => {
        executedCalls.push({
          name: call.name,
          args: call.args,
          rawArguments: call.rawArguments,
        });
        return { ok: true, source_urls: ["https://example.com/status"] };
      },
    });

    expect(result).toBe("verified from structured tool");
    expect(executedCalls).toEqual([{
      name: "web_search",
      args: { query: "status source" },
      rawArguments: "{\"query\":\"status source\"}",
    }]);
    expect(logs).toContain("local model wrote a tool call as visible text; requesting required structured tool-call repair");
    expect(JSON.stringify(seenBodies[1]!.messages)).not.toContain("web_search(query=");
    expect(seenBodies).toHaveLength(4);
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts fail closed when pseudo tool calls repeat", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  let executed = false;
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          data: [{ id: "gemma-repeated-pseudo-call" }],
        });
      }
      const body = await request.json();
      seenBodies.push(body);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "`web_search(query=\"status source\")`",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-repeated-pseudo-call");

  try {
    await expect(runFunctionToolPromptText({
      model: "local/gemma-repeated-pseudo-call",
      prompt: "find current status",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async () => {
        executed = true;
        return { ok: true };
      },
    })).rejects.toThrow("structured tool-call channel");

    expect(executed).toBe(false);
    expect(seenBodies).toHaveLength(2);
    expect(seenBodies[1]?.tool_choice).toBe("required");
  } finally {
    localServer.stop(true);
  }
});

test("registered local OpenAI-compatible model normalizes text-only tool call markup into continuations", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const executedCalls: Array<Record<string, unknown>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "<|tool_call>call:native_butler:web_search{queries:[\"status source\"]}<tool_call|>",
            },
          }],
        });
      }
      if (!Array.isArray(body.tools)) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("lookup finished"),
            },
          }],
        });
      }
      if (!Array.isArray(body.tools)) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("final from tool result"),
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "lookup finished",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-text-tool-markup");

  try {
    const result = await runFunctionToolPromptText({
      model: "local/gemma-text-tool-markup",
      prompt: "check",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            queries: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["queries"],
        },
      }],
      executeTool: async (call) => {
        executedCalls.push({
          name: call.name,
          args: call.args,
          rawArguments: call.rawArguments,
        });
        return {
          ok: true,
          echo: call.args.queries,
        };
      },
    });

    expect(result).toBe("lookup finished");
    expect(executedCalls).toEqual([{
      name: "web_search",
      args: { queries: ["status source"] },
      rawArguments: "{\"queries\":[\"status source\"]}",
    }]);
    expect(seenBodies).toHaveLength(3);
    expect(seenBodies[1]!.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      name: "web_search",
      content: expect.stringContaining("\"ok\":true"),
    }));
    const replayMessages = JSON.stringify(seenBodies[1]!.messages.slice(1));
    expect(replayMessages).not.toContain("<|tool_call>");
    expect(replayMessages).not.toContain("native_butler");
  } finally {
    localServer.stop(true);
  }
});

test("registered local model rejects marker-only text tool call markup as visible final text", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: "<|tool_call>call:native_butler:lookup{query:\"status\"}<tool_call|>",
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-marker-only-final");

  try {
    const diagnostic = await captureProviderError(() =>
      runPromptText({
        model: "local/gemma-marker-only-final",
        prompt: "hi",
      }));
    expect(diagnostic).toMatchObject({
      code: "provider_empty_response",
      provider: "local",
      api: "chat_completions",
      model: "gemma-marker-only-final",
      retryable: true,
    });
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts strip disallowed text tool call markup from visible text", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "<|tool_call>call:native_butler:delete_file{path:\"/tmp/example\"}<tool_call|>",
            "I can only use the available lookup tool.",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-disallowed-text-tool");

  try {
    const text = await runFunctionToolPromptText({
      model: "local/gemma-disallowed-text-tool",
      prompt: "check",
      tools: [{
        type: "function",
        name: "lookup",
        description: "lookup status",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }],
      executeTool: async () => {
        throw new Error("disallowed text tool markup must not execute");
      },
    });

    expect(text).toBe("I can only use the available lookup tool.");
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts strip malformed text tool call markup without execution", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            "<|tool_call>call:native_butler:web_search{queries:[\"unterminated\"]<tool_call|>",
            "I will answer from available context.",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-malformed-text-tool");

  try {
    const text = await runFunctionToolPromptText({
      model: "local/gemma-malformed-text-tool",
      prompt: "check",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            queries: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      }],
      executeTool: async () => {
        throw new Error("malformed text tool markup must not execute");
      },
    });

    expect(text).toBe("I will answer from available context.");
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts fail closed on oversized text tool call markup", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: [
            `<|tool_call>${"x".repeat(70_000)}<tool_call|>`,
            "Visible fallback after oversized marker.",
          ].join("\n"),
        },
      }],
    }),
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-oversized-text-tool");

  try {
    const text = await runFunctionToolPromptText({
      model: "local/gemma-oversized-text-tool",
      prompt: "check",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }],
      executeTool: async () => {
        throw new Error("oversized text tool markup must not execute");
      },
    });

    expect(text).toBe("Visible fallback after oversized marker.");
  } finally {
    localServer.stop(true);
  }
});

test("registered local function tool prompts keep interleaved public text without raw tool markup", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: [
                "I will check the public source now.",
                "<|tool_call>call:native_butler:web_search{queries:[\"public status\"]}<tool_call|>",
              ].join("\n"),
            },
          }],
        });
      }
      if (!Array.isArray(body.tools)) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("final from tool result"),
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "final from tool result",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-interleaved-text-tool");

  try {
    const text = await runFunctionToolPromptText({
      model: "local/gemma-interleaved-text-tool",
      prompt: "check",
      tools: [{
        type: "function",
        name: "web_search",
        description: "search the web",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            queries: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      }],
      executeTool: async () => ({ ok: true }),
    });

    expect(text).toBe("final from tool result");
    expect(seenBodies[1]!.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: "I will check the public source now.",
    }));
    const replayMessages = JSON.stringify(seenBodies[1]!.messages.slice(1));
    expect(replayMessages).not.toContain("<|tool_call>");
    expect(replayMessages).not.toContain("native_butler");
  } finally {
    localServer.stop(true);
  }
});

test("local provider overflow after admission fails as an invariant violation without a second request", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (Array.isArray(body.tools)) {
        return Response.json({
          error: {
            message: "request (19297 tokens) exceeds the available context size (16384 tokens), try increasing it",
          },
        }, { status: 400 });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "answered without tools",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-context");

  try {
    const promise = runFunctionToolPromptText({
      model: "local/gemma-context",
      instructions: "Be concise.",
      prompt: "hi",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async () => {
        throw new Error("invariant violation must not execute tools");
      },
    });

    await expect(promise).rejects.toMatchObject({ code: "admission_invariant_violation" });
    expect(seenBodies).toHaveLength(1);
    expect(Array.isArray(seenBodies[0]?.tools)).toBe(true);
  } finally {
    localServer.stop(true);
  }
});

test("local provider overflow cannot authorize a tool-schema fallback request", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool: any) => tool?.function?.name).filter(Boolean)
        : [];
      if (toolNames.includes("lookup")) {
        return Response.json({
          error: {
            message: "request (19297 tokens) exceeds the available context size (16384 tokens), try increasing it",
          },
        }, { status: 400 });
      }
      if (toolNames.includes("web_search") && !body.messages.some((message: any) => message.role === "tool")) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_search",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: "{\"query\":\"문경 날씨\",\"max_results\":2}",
                },
              }],
            },
          }],
        });
      }
      if (toolNames.length === 0) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("searched with compact tools"),
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "searched with compact tools",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-search");

  try {
    const promise = runFunctionToolPromptText({
      model: "local/gemma-search",
      instructions: "Be concise.",
      prompt: "오늘 문경 날씨는 어때?",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              max_results: { type: "integer" },
            },
            required: ["query"],
          },
        },
        {
          type: "function",
          name: "web_read",
          description: "Read a web page",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
        },
        {
          type: "function",
          name: "lookup",
          description: "Bulky local lookup",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
      executeTool: async () => {
        throw new Error("invariant violation must not execute tools");
      },
    });

    await expect(promise).rejects.toMatchObject({ code: "admission_invariant_violation" });
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["web_search", "web_read", "lookup"]);
  } finally {
    localServer.stop(true);
  }
});

test("local admission preserves a tool result before the immediate follow-up", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  let immediateToolContent = "";
  let finalSynthesisToolContent = "";
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      const toolMessage = body.messages.find((message: any) => message.role === "tool");
      if (!toolMessage) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_lookup",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"population sample\"}",
                },
              }],
            },
          }],
        });
      }

      const toolContent = String(toolMessage.content || "");
      immediateToolContent = toolContent;
      finalSynthesisToolContent = toolContent;
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: finalEnvelope("used compact tool evidence"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-large-tool-result");

  try {
    const text = await runFunctionToolPromptText({
      model: "local/gemma-large-tool-result",
      instructions: "Be concise.",
      prompt: "Collect a sample and report it.",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async () => ({
        rows: Array.from({ length: 20 }, (_, index) => ({
          id: `row-${index}`,
          value: `public evidence ${index} `.repeat(5),
        })),
        middle: "RAW_MIDDLE_SHOULD_BE_COMPACTED",
        tailRows: Array.from({ length: 20 }, (_, index) => ({
          id: `tail-row-${index}`,
          value: `tail evidence ${index} `.repeat(5),
        })),
        source_urls: ["https://example.com/critical-source-at-end"],
      }),
    });

    expect(text).toBe("used compact tool evidence");
    expect(seenBodies).toHaveLength(2);
    expect(immediateToolContent).not.toContain("completed-tool-evidence");
    expect(immediateToolContent).not.toContain("evidence_packet");
    expect(immediateToolContent).toContain("critical-source-at-end");
    expect(immediateToolContent).toContain("RAW_MIDDLE_SHOULD_BE_COMPACTED");
    expect(finalSynthesisToolContent).not.toContain("completed-tool-evidence");
    expect(finalSynthesisToolContent).toContain("RAW_MIDDLE_SHOULD_BE_COMPACTED");
    expect(seenBodies.every((body) =>
      Array.isArray(body.tools) || body.messages.some((message: any) => message.role === "tool"),
    )).toBe(true);
  } finally {
    localServer.stop(true);
  }
});

test("local function tool prompts preserve exact multi-tool results", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  let totalToolContentLength = 0;
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      const toolMessages = body.messages.filter((message: any) => message.role === "tool");
      if (toolMessages.length === 0) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: Array.from({ length: 5 }, (_, index) => ({
                id: `call_lookup_${index}`,
                type: "function",
                function: {
                  name: "lookup",
                  arguments: JSON.stringify({ query: `sample-${index}` }),
                },
              })),
            },
          }],
        });
      }

      totalToolContentLength = toolMessages.reduce(
        (sum: number, message: any) => sum + String(message.content || "").length,
        0,
      );
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: finalEnvelope("used exact tool results"),
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-multi-large-tool-result");

  try {
    const logs: string[] = [];
    const text = await runFunctionToolPromptText({
      model: "local/gemma-multi-large-tool-result",
      instructions: "Be concise.",
      prompt: "Collect several samples and report them.",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      log: (line) => logs.push(line),
      executeTool: async (call) => ({
        query: call.args.query,
        rows: Array.from({ length: 5 }, (_, index) => ({
          id: `${call.args.query}-row-${index}`,
          value: `public evidence ${index} `.repeat(2),
        })),
        middle: "RAW_MULTI_MIDDLE",
        tailRows: Array.from({ length: 5 }, (_, index) => ({
          id: `${call.args.query}-tail-row-${index}`,
          value: `tail evidence ${index} `.repeat(2),
        })),
        source_urls: [`https://example.com/${call.args.query}/source-at-end`],
      }),
    });

    expect(text).toBe("used exact tool results");
    expect(totalToolContentLength).toBeGreaterThan(0);
    expect(JSON.stringify(seenBodies[1])).toContain("RAW_MULTI_MIDDLE");
    expect(logs.some((line) => line.includes("final_synthesis_context_retry"))).toBe(false);
    expect(seenBodies).toHaveLength(2);
  } finally {
    localServer.stop(true);
  }
});

test("local final synthesis overflow after admission fails as an invariant violation", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  let compactFinalRequestSeen = false;
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      const hasToolMessage = body.messages.some((message: any) => message.role === "tool");
      const hasTools = Array.isArray(body.tools);
      const bodyText = JSON.stringify(body.messages);
      if (bodyText.includes("Compact tool evidence:")) {
        compactFinalRequestSeen = true;
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: finalEnvelope("answered from compact evidence-only synthesis"),
            },
          }],
        });
      }
      if (!hasToolMessage) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_lookup",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"status\"}",
                },
              }],
            },
          }],
        });
      }
      if (hasTools) {
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: "draft without envelope",
            },
          }],
        });
      }
      if (!compactFinalRequestSeen && bodyText.includes("Final Answer Synthesis")) {
        return Response.json({
          error: {
            message: "request (16420 tokens) exceeds the available context size (16384 tokens), try increasing it",
          },
        }, { status: 400 });
      }
      return Response.json({
        error: {
          message: "expected compact evidence-only final synthesis",
        },
      }, { status: 400 });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-final-overflow");

  try {
    const promise = runFunctionToolPromptText({
      model: "local/gemma-final-overflow",
      instructions: "Be concise.",
      prompt: "Use the tool evidence and answer.",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      executeTool: async () => ({
        rows: Array.from({ length: 120 }, (_, index) => ({
          id: `row-${index}`,
          value: `public evidence ${index} `.repeat(20),
        })),
        source_urls: ["https://example.com/final-overflow-source"],
      }),
    });

    await expect(promise).rejects.toMatchObject({
      code: "model_request_context_capacity_exceeded",
    });
    expect(compactFinalRequestSeen).toBe(false);
    expect(seenBodies).toHaveLength(1);
  } finally {
    localServer.stop(true);
  }
});

test("local overflow cannot authorize compact-schema or no-tool fallback requests", async () => {
  const seenBodies: Array<Record<string, any>> = [];
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      seenBodies.push(body);
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        return Response.json({
          error: {
            message: "request (18000 tokens) exceeds the available context size (16384 tokens), try increasing it",
          },
        }, { status: 400 });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "answered without tools after compact overflow",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-compact-overflow");

  try {
    const promise = runFunctionToolPromptText({
      model: "local/gemma-compact-overflow",
      instructions: "Be concise.",
      prompt: "오늘 문경 날씨는 어때?",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
        {
          type: "function",
          name: "web_read",
          description: "Read a web page",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
        },
        {
          type: "function",
          name: "lookup",
          description: "Bulky local lookup",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
      executeTool: async () => ({ ok: true }),
    });

    await expect(promise).rejects.toMatchObject({ code: "admission_invariant_violation" });
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]?.tools.map((tool: any) => tool.function.name)).toEqual(["web_search", "web_read", "lookup"]);
  } finally {
    localServer.stop(true);
  }
});

test("local function tool request honors cancellation before admission", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      if (Array.isArray(body.tools)) {
        return Response.json({
          error: {
            message: "maximum context length exceeded",
          },
        }, { status: 400 });
      }
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "should not be reached",
          },
        }],
      });
    },
  });
  writeLocalModelConfig(localServer.url.toString(), "gemma-abort");

  try {
    const controller = new AbortController();
    controller.abort();
    const promise = runFunctionToolPromptText({
      model: "local/gemma-abort",
      prompt: "hi",
      signal: controller.signal,
      tools: [{
        type: "function",
        name: "lookup",
        description: "Lookup a value",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }],
      executeTool: async () => {
        throw new Error("cancelled fallback must not execute tools");
      },
    });

    await expect(promise).rejects.toThrow("Runtime turn was cancelled.");
  } finally {
    localServer.stop(true);
  }
});

function writeLocalModelConfig(
  serverUrl: string,
  modelId: string,
  options: {
    reasoningBudgetRatio?: number;
    platform?: "llama_cpp" | "ollama" | "lm_studio" | "custom";
    system?: Record<string, unknown>;
  } = {},
): void {
  const root = serverUrl.replace(/\/$/u, "");
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    ...(options.system ? { system: options.system } : {}),
    models: {
      local: [{
        provider_id: "local",
        provider_label: "Local",
        model_id: modelId,
        model_ref: `local/${modelId}`,
        display_name: modelId,
        api_type: "openai_compatible",
        platform: options.platform ?? "llama_cpp",
        server_url: root,
        api_base_url: `${root}/v1`,
        context_window_tokens: 16_384,
        max_output_tokens: 4_096,
        reasoning_budget_ratio: options.reasoningBudgetRatio,
        token_estimator: "character_estimate",
        source: "manual",
        source_url: "unit",
        runtime_supported: true,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      }],
    },
  }), "utf8");
}

test("runtime messages resolve from response language before interface language", () => {
  expect(resolveRuntimeMessageLanguage({ butlerData: tempDir })).toBe("en");

  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    user: { language: "ko" },
  }), "utf8");

  expect(resolveRuntimeMessageLanguage({ butlerData: tempDir })).toBe("ko");
  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    user: { language: "ko", responseLanguage: "en" },
  }), "utf8");

  expect(resolveRuntimeMessageLanguage({ butlerData: tempDir })).toBe("en");
  expect(runtimeMessages("ko").ungroundedWorkerDispatch()).toContain("확인하지 못했습니다");
  expect(runtimeMessages("en").ungroundedWorkerDispatch()).toContain("could not verify");
});

test("Codex subscription profile routes prompts to the Codex backend", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";
  process.env.BUTLER_CODEX_USER_AGENT = "butler-test";

  let seenUrl = "";
  let seenBody: Record<string, any> = {};
  let seenHeaders: Headers;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body || "{}"));
    const body = [
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"input_tokens_details":{"cached_tokens":0}}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({ model: "gpt-5.5-codex", prompt: "hi" })).resolves.toBe("hello");
  expect(seenUrl).toBe("https://chatgpt.example/backend-api/codex/responses");
  expect(seenHeaders!.get("authorization")).toBe(`Bearer ${token}`);
  expect(seenHeaders!.get("chatgpt-account-id")).toBe("chatgpt-account");
  expect(seenHeaders!.get("openai-beta")).toBe("responses=experimental");
  expect(seenHeaders!.get("originator")).toBe("butler");
  expect(seenHeaders!.get("user-agent")).toBe("butler-test");
  expect(seenBody.model).toBe("gpt-5.5");
  expect(seenBody.instructions).toBe("You are Butler, a helpful personal AI assistant.");
  expect(seenBody.input).toEqual([{
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  }]);
  expect(seenBody.stream).toBe(true);
  expect(seenBody.store).toBe(false);
  expect(seenBody.prompt_cache_retention).toBeUndefined();
  expect(seenBody.include).toBeUndefined();
});

test("Codex subscription SSE projects provider chunks before final response resolves", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";
  process.env.BUTLER_CODEX_USER_AGENT = "butler-test";

  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(
        'data: {"type":"response.output_text.delta","response_id":"resp_live","delta":"hello"}\n\n',
      ));
    },
  }), { status: 200 })) as unknown as typeof fetch;

  let resolved = false;
  let firstCallbackResolve: (() => void) | null = null;
  const firstCallback = new Promise<void>((resolve) => {
    firstCallbackResolve = resolve;
  });
  const chunks: Array<Record<string, unknown>> = [];
  const resultPromise = runPromptText({
    model: "gpt-5.5-codex",
    prompt: "hi",
    onProviderStreamEvent: (chunk) => {
      chunks.push(chunk);
      firstCallbackResolve?.();
    },
  }).then((result) => {
    resolved = true;
    return result;
  });

  await firstCallback;
  expect(resolved).toBe(false);
  expect(chunks[0]).toMatchObject({
    type: "text_delta",
    streamId: "resp_live",
    sequence: 1,
    textDelta: "hello",
    target: "final_candidate",
  });

  streamController!.enqueue(encoder.encode([
    'data: {"type":"response.completed","response":{"id":"resp_live","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n"));
  streamController!.close();

  await expect(resultPromise).resolves.toBe("hello");
  expect(resolved).toBe(true);
  expect(chunks.at(-1)).toMatchObject({
    type: "completed",
    streamId: "resp_live",
    status: "completed",
  });
});

test("Codex subscription SSE ignores rejecting stream callbacks without retrying provider call", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";
  process.env.BUTLER_CODEX_USER_AGENT = "butler-test";

  let fetchCalls = 0;
  let callbackCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    const body = [
      'data: {"type":"response.output_text.delta","response_id":"resp_reject","delta":"hello"}',
      "",
      'data: {"type":"response.reasoning_text.delta","response_id":"resp_reject","delta":"private reasoning"}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_reject","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  await expect(runPromptText({
    model: "gpt-5.5-codex",
    prompt: "hi",
    onProviderStreamEvent: () => {
      callbackCalls += 1;
      throw new Error("stream projection sink rejected");
    },
  })).resolves.toBe("hello");

  expect(fetchCalls).toBe(1);
  expect(callbackCalls).toBeGreaterThan(0);
});

test("Codex subscription tool continuation is sent as stateless input without previous_response_id", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length === 1) {
      return new Response([
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"large-hidden-reasoning-state"}}',
        "",
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"status\\"}"}}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"total_tokens":2}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 });
    }
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"done"}]}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","usage":{"input_tokens":2,"total_tokens":3}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "check",
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    }],
    executeTool: async (call) => ({
      ok: true,
      echo: call.args.query,
    }),
  });

  expect(result).toBe("done");
  expect(seenBodies).toHaveLength(2);
  expect(seenBodies[0]!.previous_response_id).toBeUndefined();
  expect(seenBodies[1]!.previous_response_id).toBeUndefined();
  expect(seenBodies[1]!.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "check" }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: "{\"query\":\"status\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: expect.stringContaining("\"ok\":true"),
    },
  ]);
  expect(JSON.stringify(seenBodies[1]!.input)).not.toContain("large-hidden-reasoning-state");
  expect(JSON.stringify(seenBodies[1]!.input)).not.toContain("encrypted_content");
});

test("Codex stateless replay keeps prior web results provider-compact", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    seenBodies.push(JSON.parse(String(init?.body || "{}")));
    if (seenBodies.length === 1) {
      return codexSseResponse({
        id: "resp_web_search",
        item: {
          type: "function_call",
          call_id: "call_web_search",
          name: "web_search",
          arguments: JSON.stringify({ query: "current market" }),
        },
        inputTokens: 10,
        totalTokens: 12,
      });
    }
    if (seenBodies.length === 2) {
      return codexSseResponse({
        id: "resp_web_read",
        item: {
          type: "function_call",
          call_id: "call_web_read",
          name: "web_read",
          arguments: JSON.stringify({ url: "https://example.com/market" }),
        },
        inputTokens: 20,
        totalTokens: 22,
      });
    }
    return codexSseResponse({
      id: "resp_web_final",
      item: {
        type: "message",
        content: [{ type: "output_text", text: "done" }],
      },
      inputTokens: 30,
      totalTokens: 32,
    });
  }) as unknown as typeof fetch;

  const rawSearchMarker = "RAW_SEARCH_DUPLICATE_RESULT";
  const rawReadReceiptMarker = "RAW_READ_RECEIPT_DUPLICATE";
  const rawReadChunkMarker = "RAW_PAGE_CHUNK_DUPLICATE";
  const pageBodyMarker = "PAGE_BODY_FACT";
  const pageMarkdown = `${pageBodyMarker}\n${"bounded source content ".repeat(180)}`;
  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "Research the current market.",
    maxToolRounds: 3,
    tools: [{
      type: "function",
      name: "web_search",
      description: "Search public sources.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }, {
      type: "function",
      name: "web_read",
      description: "Read one public source.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    }],
    executeTool: async (call) => {
      if (call.name === "web_search") {
        return {
          ok: true,
          query: call.args.query,
          results: [{ raw_duplicate: rawSearchMarker }],
          public_web_evidence_items: [{
            evidence_item_id: "public-web-search-1",
            source_url: "https://example.com/market",
            source_identity: "example.com",
            published_at: "2026-07-31",
            content_kind: "search_snippet",
            bounded_content: "The market source reports a current move.",
            limitations: ["Search excerpt."],
          }],
          search_warnings: ["One planned query failed."],
          failed_queries: [{ query: "blocked query", error: "challenge" }],
          read_required: true,
          read_reason: "Verify the source before reporting.",
          recommended_read_urls: ["https://example.com/market"],
          evidence_receipts: [{ raw_duplicate: rawSearchMarker }],
        };
      }
      return {
        ok: true,
        requested_url: call.args.url,
        source_url: call.args.url,
        title: "Current market source",
        status: 200,
        markdown: pageMarkdown,
        chunks: [{ text: rawReadChunkMarker }],
        truncated: true,
        evidence_quality: "limited",
        warnings: ["The page was truncated."],
        public_web_evidence_items: [{
          evidence_item_id: "public-web-read-1",
          source_url: "https://example.com/market",
          source_identity: "example.com",
          published_at: null,
          content_kind: "page_excerpt",
          bounded_content: "A bounded page excerpt confirms the market move.",
          limitations: ["The page evidence was truncated."],
        }],
        evidence_receipts: [{ raw_duplicate: rawReadReceiptMarker }],
      };
    },
  });

  expect(result).toBe("done");
  expect(seenBodies).toHaveLength(3);
  const secondOutputs = seenBodies[1]!.input.filter(
    (item: Record<string, unknown>) => item.type === "function_call_output",
  );
  const thirdOutputs = seenBodies[2]!.input.filter(
    (item: Record<string, unknown>) => item.type === "function_call_output",
  );
  expect(secondOutputs).toHaveLength(1);
  expect(thirdOutputs).toHaveLength(2);
  expect(thirdOutputs[0]!.output).toBe(secondOutputs[0]!.output);

  const searchPayload = JSON.parse(String(thirdOutputs[0]!.output));
  expect(searchPayload.output).toMatchObject({
    tool_name: "web_search",
    read_required: true,
    search_warnings: ["One planned query failed."],
    failed_queries: [{ query: "blocked query", error: "challenge" }],
    recommended_read_urls: ["https://example.com/market"],
  });
  expect(searchPayload.output.evidence_items[0]).toMatchObject({
    source_url: "https://example.com/market",
    bounded_content: "The market source reports a current move.",
  });
  expect(searchPayload.output.results).toBeUndefined();
  expect(searchPayload.output.evidence_receipts).toBeUndefined();

  const readPayload = JSON.parse(String(thirdOutputs[1]!.output));
  expect(readPayload.output).toMatchObject({
    tool_name: "web_read",
    source_url: "https://example.com/market",
    title: "Current market source",
    status: 200,
    truncated: true,
    evidence_quality: "limited",
    warnings: ["The page was truncated."],
  });
  expect(readPayload.output.page_excerpt).toContain(pageBodyMarker);
  expect(readPayload.output.page_excerpt.length).toBeLessThanOrEqual(2_000);
  expect(readPayload.output.evidence_items[0]).toMatchObject({
    source_url: "https://example.com/market",
    bounded_content: "A bounded page excerpt confirms the market move.",
  });
  expect(readPayload.output.markdown).toBeUndefined();
  expect(readPayload.output.chunks).toBeUndefined();
  expect(readPayload.output.evidence_receipts).toBeUndefined();
  expect(JSON.stringify(seenBodies[2]!.input)).not.toContain(rawSearchMarker);
  expect(JSON.stringify(seenBodies[2]!.input)).not.toContain(rawReadReceiptMarker);
  expect(JSON.stringify(seenBodies[2]!.input)).not.toContain(rawReadChunkMarker);
});

test("Codex typed tool batches hand off before a continuation response request", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenBodies.push(JSON.parse(String(init?.body || "{}")));
    if (seenBodies.length > 1) throw new Error("unexpected hidden continuation request");
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"status\\"}"}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"total_tokens":2}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "check",
    maxToolRounds: 1,
    handoffAfterToolBatch: true,
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    executeTool: async () => ({ ok: true }),
  });

  expect(isToolBatchCompletedHandoffText(result)).toBe(true);
  expect(seenBodies).toHaveLength(1);
});

test("OpenAI function tool prompt reserves budget for final synthesis instead of exceeding request budget", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    accountId: "chatgpt-account",
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";

  const seenBodies: Array<Record<string, any>> = [];
  let fetchCalls = 0;
  let requestCount = 0;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    fetchCalls += 1;
    if (fetchCalls === 32) {
      return codexSseResponse({
        id: "resp_32",
        item: {
          type: "message",
          content: [{ type: "output_text", text: "done at budget" }],
        },
        inputTokens: 32,
        totalTokens: 55,
      });
    }
    if (fetchCalls > 32) {
      return codexSseResponse({
        id: `resp_${fetchCalls}`,
        item: {
          type: "message",
          content: [{ type: "output_text", text: "should not exceed budget" }],
        },
        inputTokens: fetchCalls,
        totalTokens: fetchCalls,
      });
    }
    return codexSseResponse({
      id: `resp_${fetchCalls}`,
      item: {
        type: "function_call",
        call_id: `call_${fetchCalls}`,
        name: "lookup",
        arguments: "{\"query\":\"again\"}",
      },
      inputTokens: 1,
      totalTokens: 2,
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "loop",
    maxToolRounds: 40,
    cacheScope: "session-turn",
    butlerData: tempDir,
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    usageAttribution: {
      turnId: "turn-high-model-calls",
      phase: "initial_tool_loop",
      beforeModelRequest: () => {
        requestCount += 1;
      },
      getBudgetState: () => ({
        status: requestCount >= 32 ? "exhausted" : requestCount >= 30 ? "warning" : "ok",
        requestCount,
        maxRequests: 32,
      }),
    },
    executeTool: async () => ({ ok: true }),
  });

  expect(result).toBe("done at budget");
  expect(fetchCalls).toBe(32);
  expect(requestCount).toBe(32);
  expect(seenBodies).toHaveLength(32);
  expect(seenBodies.slice(0, 31).every((body) => Array.isArray(body.tools))).toBe(true);
  expect(seenBodies[31]!.tools).toBeUndefined();
  expect(seenBodies[31]!.instructions).toContain("Do not call any more tools");
  const events = readPromptCacheMetrics({ butlerData: tempDir })
    .filter((event) => event.turnId === "turn-high-model-calls");
  expect(events).toHaveLength(32);
  expect(events.at(29)?.budgetState).toMatchObject({
    status: "warning",
    requestCount: 30,
    maxRequests: 32,
  });
  expect(events.at(-1)?.budgetState).toMatchObject({
    status: "exhausted",
    requestCount: 32,
    maxRequests: 32,
  });
});

test("OpenAI function tool prompt records live budgetState for each provider usage event", async () => {
  const token = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "chatgpt-account",
    },
  });
  writeButlerOpenAIAuthProfile({
    provider: "openai-codex",
    type: "oauth",
    accessToken: token,
    accountId: "chatgpt-account",
    provenance: "codex-subscription-oauth",
    updatedAt: new Date(0).toISOString(),
  });
  process.env.BUTLER_CODEX_BASE_URL = "https://chatgpt.example/backend-api";

  let fetchCalls = 0;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return codexSseResponse({
        id: "resp_1",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"query\":\"status\"}",
        },
        inputTokens: 10,
        totalTokens: 15,
      });
    }
    return codexSseResponse({
      id: "resp_2",
      item: {
        type: "message",
        content: [{ type: "output_text", text: "done" }],
      },
      inputTokens: 20,
      totalTokens: 30,
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "check",
    cacheScope: "session-turn",
    butlerData: tempDir,
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    usageAttribution: {
      turnId: "turn-live-budget",
      phase: "initial_tool_loop",
      beforeModelRequest: () => {
        requestCount += 1;
      },
      getBudgetState: () => ({
        status: requestCount >= 2 ? "warning" : "ok",
        requestCount,
        maxRequests: 3,
      }),
    },
    executeTool: async () => ({ ok: true }),
  });

  expect(result).toBe("done");
  const events = readPromptCacheMetrics({ butlerData: tempDir })
    .filter((event) => event.turnId === "turn-live-budget");
  expect(events.map((event) => event.budgetState?.requestCount)).toEqual([1, 2]);
  expect(events.map((event) => event.budgetState?.status)).toEqual(["ok", "warning"]);
});

test("OpenAI function tool prompts send compact tool schemas to the model", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://api.openai.example/v1";

  let seenBody: Record<string, any> = {};
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenBody = JSON.parse(String(init?.body || "{}"));
    return Response.json({
      id: "resp_final",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "done" }],
      }],
      usage: { input_tokens: 1, total_tokens: 2 },
    });
  }) as unknown as typeof fetch;

  await expect(runFunctionToolPromptText({
    model: "gpt-5.5",
    prompt: "check",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Top-level tool description stays available.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Nested parameter prose should not be sent to the model.",
          },
          mode: {
            type: "string",
            enum: ["quick", "deep"],
            description: "Enum prose should not be sent either.",
          },
        },
        required: ["query"],
      },
    }],
    executeTool: async () => ({ ok: true }),
  })).resolves.toBe("done");

  expect(seenBody.tools).toEqual([{
    type: "function",
    name: "lookup",
    description: "Top-level tool description stays available.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["quick", "deep"] },
      },
      required: ["query"],
    },
  }]);
  expect(JSON.stringify(seenBody.tools)).not.toContain("Nested parameter prose");
});

test("OpenAI function tool prompt refreshes promoted dynamic schemas between tool rounds", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_BASE_URL = "https://api.openai.example/v1";

  let promoteLookup = false;
  const seenBodies: Array<Record<string, any>> = [];
  const executedToolNames: string[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length === 1) {
      return Response.json({
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "tool_describe",
          arguments: JSON.stringify({ ids: ["native:lookup"] }),
        }],
      });
    }
    if (seenBodies.length === 2) {
      return Response.json({
        id: "resp_2",
        output: [{
          type: "function_call",
          call_id: "call_2",
          name: "lookup",
          arguments: JSON.stringify({ query: "status" }),
        }],
      });
    }
    return Response.json({
      id: "resp_3",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "done" }],
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5",
    prompt: "check promoted tool",
    maxToolRounds: 3,
    tools: [{
      type: "function",
      name: "tool_describe",
      description: "Describe a tool before promotion.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
      },
    }],
    dynamicTools: () => {
      const base = [{
        type: "function" as const,
        name: "tool_describe",
        description: "Describe a tool before promotion.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ids: { type: "array", items: { type: "string" } },
          },
          required: ["ids"],
        },
      }];
      if (!promoteLookup) return base;
      return [...base, {
        type: "function" as const,
        name: "lookup",
        description: "Promoted lookup tool.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }];
    },
    executeTool: async (call) => {
      executedToolNames.push(call.name);
      if (call.name === "tool_describe") {
        promoteLookup = true;
        return { ok: true, described: call.args.ids };
      }
      return { ok: true, name: call.name, query: call.args.query };
    },
  });

  expect(result).toBe("done");
  expect(seenBodies).toHaveLength(3);
  expect(executedToolNames).toEqual(["tool_describe", "lookup"]);
  expect(seenBodies[0]!.tools.map((tool: { name: string }) => tool.name)).toEqual(["tool_describe"]);
  expect(seenBodies[1]!.tools.map((tool: { name: string }) => tool.name)).toEqual(["tool_describe", "lookup"]);
  expect(seenBodies[1]!.input).toEqual([{
    type: "function_call_output",
    call_id: "call_1",
    output: expect.stringContaining("\"ok\":true"),
  }]);
});

test("function tool prompt normalizes model tool names before dispatch", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  const seenCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.previous_response_id) {
      return Response.json({
        id: "resp_final",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "done" }],
        }],
      });
    }
    return Response.json({
      id: "resp_1",
      output: [{
        type: "function_call",
        call_id: "call_1",
        name: "lookup ",
        arguments: JSON.stringify({ query: "status" }),
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "check",
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    }],
    executeTool: async (call) => {
      seenCalls.push({ name: call.name, args: call.args });
      return { ok: true };
    },
  });

  expect(result).toBe("done");
  expect(seenCalls).toEqual([{ name: "lookup", args: { query: "status" } }]);
});

test("function tool prompt synthesizes a final answer instead of exposing tool budget fallback", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length === 1) {
      return Response.json({
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: JSON.stringify({ query: "first" }),
        }],
      });
    }
    if (seenBodies.length === 2) {
      return Response.json({
        id: "resp_2",
        output: [{
          type: "function_call",
          call_id: "call_2",
          name: "lookup",
          arguments: JSON.stringify({ query: "second" }),
        }],
      });
    }
    return Response.json({
      id: "resp_3",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "최종 요약입니다." }],
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "내일 날씨 요약",
    maxToolRounds: 2,
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    }],
    executeTool: async (call) => ({
      ok: true,
      query: call.args.query,
    }),
  });

  expect(result).toBe("최종 요약입니다.");
  expect(seenBodies).toHaveLength(3);
  expect(seenBodies[2]!.tools).toBeUndefined();
  expect(seenBodies[2]!.previous_response_id).toBe("resp_2");
  expect(seenBodies[2]!.instructions).toContain("Do not call any more tools");
  expect(seenBodies[2]!.input).toEqual([{
    type: "function_call_output",
    call_id: "call_2",
    output: expect.stringContaining("\"ok\":true"),
  }]);
});

test("function tool prompt can terminate immediately from a terminal tool result", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seenBodies.push(JSON.parse(String(init?.body || "{}")));
    return Response.json({
      id: "resp_1",
      output: [{
        type: "function_call",
        call_id: "call_1",
        name: "publish",
        arguments: JSON.stringify({ report: "ready" }),
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "publish",
    tools: [{
      type: "function",
      name: "publish",
      description: "publish report",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          report: { type: "string" },
        },
        required: ["report"],
      },
    }],
    executeTool: async () => ({ report: "최종 보고입니다." }),
    finalTextFromToolResult: ({ output }) => {
      const toolOutput = output as { report?: string };
      return toolOutput.report ?? null;
    },
  });

  expect(result).toBe("최종 보고입니다.");
  expect(seenBodies).toHaveLength(1);
});

test("function tool prompt falls back safely when final synthesis fails", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  const logs: string[] = [];
  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length === 1) {
      return Response.json({
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: JSON.stringify({ query: "first" }),
        }],
      });
    }
    return Response.json({ error: { message: "temporary backend failure" } }, { status: 503 });
  }) as unknown as typeof fetch;

  const result = await runFunctionToolPromptText({
    model: "gpt-5.5-codex",
    prompt: "내일 날씨 요약",
    maxToolRounds: 1,
    log: (line) => logs.push(line),
    tools: [{
      type: "function",
      name: "lookup",
      description: "lookup status",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    }],
    executeTool: async (call) => ({
      ok: true,
      query: call.args.query,
    }),
  });

  expect(result).toContain("available tool budget");
  expect(result).toContain("lookup: ok");
  expect(result).not.toContain("agent loop");
  expect(logs.some((line) => line.includes("final no-tool synthesis failed"))).toBe(true);
  expect(seenBodies).toHaveLength(4);
});

test("shell worker synthesizes a report when the shell tool budget is reached", async () => {
  process.env.BUTLER_RUNTIME = "codex-api";
  process.env.OPENAI_API_KEY = "sk-test";

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length <= 60) {
      return Response.json({
        id: `resp_${seenBodies.length}`,
        output: [{
          type: "function_call",
          call_id: `call_${seenBodies.length}`,
          name: "run_shell",
          arguments: JSON.stringify({
            command: "pwd",
            justification: "confirm workspace",
          }),
        }],
      });
    }
    return Response.json({
      id: "resp_final",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "최종 워커 보고입니다." }],
      }],
    });
  }) as unknown as typeof fetch;

  const updates: Array<{ phase: string; statusLine: string }> = [];
  const result = await runShellTask({
    model: "gpt-5.5-codex",
    prompt: "프로젝트를 조사해줘",
    projectPath: tempDir,
    onActivity: (update) => {
      updates.push(update);
    },
  });

  expect(result).toBe("최종 워커 보고입니다.");
  expect(seenBodies).toHaveLength(61);
  expect(seenBodies[60]!.tools).toBeUndefined();
  expect(seenBodies[60]!.previous_response_id).toBe("resp_60");
  expect(seenBodies[60]!.instructions).toContain("Do not call any more tools");
  expect(seenBodies[60]!.input).toEqual([{
    type: "function_call_output",
    call_id: "call_60",
    output: expect.any(String),
  }]);
  expect(updates.some((update) => update.phase === "reporting")).toBe(true);
});

test("shell worker falls back from local chat model to configured OpenAI tool model", async () => {
  process.env.BUTLER_RUNTIME = "codex-api";
  process.env.OPENAI_API_KEY = "sk-test";
  writeLocalModelConfig("http://127.0.0.1:8080", "gemma-worker", {
    system: {
      openaiModel: "gpt-5.5-codex",
    },
  });

  const seenBodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    return Response.json({
      id: "resp_tool_model",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "worker used tool model" }],
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runShellTask({
    model: "local/gemma-worker",
    prompt: "프로젝트를 조사해줘",
    projectPath: tempDir,
  });

  expect(result).toBe("worker used tool model");
  expect(seenBodies).toHaveLength(1);
  expect(seenBodies[0]!.model).toBe("gpt-5.5-codex");
  expect(JSON.stringify(seenBodies)).not.toContain("gemma-worker");
});

test("shell worker normalizes run_shell tool names with surrounding whitespace", async () => {
  process.env.BUTLER_RUNTIME = "codex-api";
  process.env.OPENAI_API_KEY = "sk-test";

  const seenBodies: Array<Record<string, any>> = [];
  const logs: string[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body || "{}"));
    seenBodies.push(body);
    if (seenBodies.length === 1) {
      return Response.json({
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "run_shell ",
          arguments: JSON.stringify({
            command: "pwd",
            justification: "confirm workspace",
          }),
        }],
      });
    }
    return Response.json({
      id: "resp_2",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "보고 완료" }],
      }],
    });
  }) as unknown as typeof fetch;

  const result = await runShellTask({
    model: "gpt-5.5-codex",
    prompt: "프로젝트를 조사해줘",
    projectPath: tempDir,
    log: (line) => logs.push(line),
  });

  expect(result).toBe("보고 완료");
  expect(logs.some((line) => line.includes("run_shell (confirm workspace): pwd"))).toBe(true);
  expect(seenBodies).toHaveLength(2);
  expect(seenBodies[1]!.input).toEqual([{
    type: "function_call_output",
    call_id: "call_1",
    output: expect.any(String),
  }]);
});
