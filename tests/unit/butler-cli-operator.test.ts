import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recordOperationalMetric } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { TaskNotificationQueue } from "../../packages/butler-agent/src/agent/work/task-notifications.ts";
import { createBoxItem, readBoxManifest } from "../../packages/butler-agent/src/agent/cognition/box/store.ts";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import { createKnowHowEntry, readKnowHowEntry, recordSourceQualityEvent } from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";
import { createMemoryChunk } from "../../packages/butler-agent/src/agent/cognition/memory/metadata.ts";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-operator-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string[], butlerData: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync(["node", cli, ...args, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_WEB_SEARCH_PROVIDER: "",
      BUTLER_BRAVE_SEARCH_API_KEY: "",
      BRAVE_SEARCH_API_KEY: "",
      BUTLER_TAVILY_API_KEY: "",
      TAVILY_API_KEY: "",
      ...extraEnv,
      BUTLER_DATA: butlerData,
      BUTLER_HOME: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runCliWithStdin(
  args: string[],
  butlerData: string,
  stdin: string,
  extraEnv: Record<string, string> = {},
) {
  return Bun.spawnSync(["node", cli, ...args, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      BUTLER_DATA: butlerData,
      BUTLER_HOME: root,
    },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

function stderrText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stderr);
}

function writeTask(butlerData: string, taskId: string, input: {
  status: string;
  request?: string;
  result?: string;
  pid?: string;
}): void {
  const taskDir = join(butlerData, "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), `${input.status}\n`, "utf8");
  if (input.request) writeFileSync(join(taskDir, "request.md"), `${input.request}\n`, "utf8");
  if (input.result) writeFileSync(join(taskDir, "result.md"), `${input.result}\n`, "utf8");
  if (input.pid) writeFileSync(join(taskDir, "pid"), `${input.pid}\n`, "utf8");
}

test("operator config commands validate and redact private paths", () => {
  const butlerData = tempRoot();
  try {
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      system: {
        runtime: "codex-api",
        defaultModel: "openai/gpt-5.5-codex",
      },
      metrics: {
        enabled: true,
      },
    }));

    const get = runCli(["config", "get", "system.defaultModel", "--json"], butlerData);
    expect(get.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(get));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.value).toBe("openai/gpt-5.5-codex");

    const secret = runCli(["config", "get", "auth.refreshToken", "--json"], butlerData);
    parsed = JSON.parse(stdoutText(secret));
    expect(parsed.data.redacted).toBe(true);
    expect(stdoutText(secret)).not.toContain("refresh-token");

    const set = runCli(["config", "set", "metrics.enabled", "false", "--json"], butlerData);
    expect(set.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(set));
    expect(parsed.data.newValue).toBe(false);
    expect(JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8")).metrics.enabled).toBe(false);

    const validate = runCli(["config", "validate", "--json"], butlerData);
    expect(validate.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(validate));
    expect(parsed.data.ok).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("gateway CLI manages app gateway settings through safe output", () => {
  const butlerData = tempRoot();
  try {
    const dbPath = join(butlerData, "private", "app.sqlite");
    const configured = runCli([
      "gateway",
      "configure",
      "app",
      "--host",
      "127.0.0.1",
      "--port",
      "19001",
      "--db",
      dbPath,
      "--json",
    ], butlerData);
    expect(configured.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(configured));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.config).toMatchObject({
      host: "127.0.0.1",
      port: 19001,
      serverUrl: "http://127.0.0.1:19001",
      dbConfigured: true,
    });
    expect(stdoutText(configured)).not.toContain(dbPath);

    const stored = JSON.parse(
      readFileSync(join(butlerData, "gateways", "app.json"), "utf8"),
    );
    expect(stored).toMatchObject({
      id: "app",
      enabled: true,
      config: {
        host: "127.0.0.1",
        port: 19001,
        dbPath,
      },
    });

    const list = runCli(["gateway", "list", "--json"], butlerData);
    expect(list.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(list));
    expect(parsed.data.gateways.map((gateway: { id: string }) => gateway.id)).toEqual([
      "app",
      "telegram",
    ]);

    const status = runCli(["gateway", "status", "app"], butlerData);
    expect(status.exitCode).toBe(0);
    expect(stdoutText(status)).toContain("url: http://127.0.0.1:19001");

    const disabled = runCli(["gateway", "disable", "app", "--json"], butlerData);
    expect(disabled.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(disabled));
    expect(parsed.data.enabled).toBe(false);
    expect(parsed.data.status).toBe("disabled");

    const inspected = runCli(["gateway", "inspect", "app", "--json"], butlerData);
    expect(inspected.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(inspected));
    expect(parsed.data.settingsPath).toBe("gateways/app.json");
    expect(stdoutText(inspected)).not.toContain(butlerData);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("gateway CLI manages Telegram credentials and embedded lifecycle safely", () => {
  const butlerData = tempRoot();
  try {
    const freshStatus = runCli(["gateway", "status", "telegram", "--json"], butlerData);
    expect(freshStatus.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(freshStatus));
    expect(parsed.data).toMatchObject({
      enabled: false,
      configured: false,
      running: false,
      status: "disabled",
    });
    expect(parsed.data.nextActions).toEqual(["butler gateway enable telegram"]);

    const token = "123456:test-secret-token";
    const credential = runCliWithStdin([
      "gateway",
      "credential",
      "set",
      "telegram",
      "--token-stdin",
      "--json",
    ], butlerData, `${token}\n`);
    expect(credential.exitCode).toBe(0);
    expect(stdoutText(credential)).not.toContain(token);
    parsed = JSON.parse(stdoutText(credential));
    expect(parsed.data).toMatchObject({
      gateway: "telegram",
      tokenStored: true,
      tokenValueIncluded: false,
    });

    const configured = runCli([
      "gateway",
      "configure",
      "telegram",
      "--chat-id",
      "12345",
      "--format",
      "plain",
      "--json",
    ], butlerData);
    expect(configured.exitCode).toBe(0);
    expect(stdoutText(configured)).not.toContain(token);
    expect(stdoutText(configured)).not.toContain("12345");
    parsed = JSON.parse(stdoutText(configured));
    expect(parsed.data.config).toMatchObject({
      chatPaired: true,
      defaultFormat: "plain",
    });

    const privateEnv = readFileSync(join(butlerData, ".env"), "utf8");
    expect(privateEnv).toContain("TELEGRAM_BOT_TOKEN");
    expect(privateEnv).toContain("TELEGRAM_CHAT_ID");
    const compatibility = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    );
    expect(compatibility.telegram).toMatchObject({
      groupId: "12345",
      defaultFormat: "plain",
    });

    const status = runCli(["gateway", "status", "telegram", "--json"], butlerData);
    expect(status.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(status));
    expect(parsed.data).toMatchObject({
      enabled: true,
      running: true,
      status: "embedded",
      lifecycle: "embedded",
      configured: true,
      credentials: {
        botToken: true,
      },
    });
    expect(stdoutText(status)).not.toContain(token);
    expect(stdoutText(status)).not.toContain("12345");

    const restartWithoutYes = runCli(["gateway", "restart", "telegram", "--json"], butlerData);
    expect(restartWithoutYes.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(restartWithoutYes)).error.code).toBe("invalid_arguments");

    const restart = runCli(["gateway", "restart", "telegram", "--yes", "--json"], butlerData);
    expect(restart.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(restart));
    expect(parsed.data).toMatchObject({
      gateway: "telegram",
      lifecycle: "embedded",
      restarted: false,
      restartRequired: true,
      serviceCommand: "butler restart",
    });

    const unpairWithoutYes = runCli(["gateway", "unpair", "telegram", "--json"], butlerData);
    expect(unpairWithoutYes.exitCode).toBe(2);
    const unpair = runCli(["gateway", "unpair", "telegram", "--yes", "--json"], butlerData);
    expect(unpair.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(unpair));
    expect(parsed.data).toMatchObject({
      gateway: "telegram",
      chatPaired: false,
      tokenConfigured: true,
    });

    const disabled = runCli(["gateway", "disable", "telegram", "--json"], butlerData);
    expect(disabled.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(disabled));
    expect(parsed.data).toMatchObject({
      enabled: false,
      status: "disabled",
      restartRecommended: false,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 15_000);

test("operator personalization commands persist naming profile privately", () => {
  const butlerData = tempRoot();
  try {
    const set = runCli([
      "personalization",
      "set",
      "--butler-nickname",
      "Alfred",
      "--principal-name",
      "Bruce Wayne",
      "--preferred-address",
      "Master Wayne",
      "--json",
    ], butlerData);
    expect(set.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(set));
    expect(parsed.data.storage_label).toBe("personalization/profile.json");
    expect(parsed.data.updated_fields).toEqual([
      "butler_nickname",
      "preferred_address",
      "principal_name",
    ]);
    expect(parsed.data.profile).toMatchObject({
      butler_nickname: "Alfred",
      principal_name: "Bruce Wayne",
      preferred_address: "Master Wayne",
    });
    expect(stdoutText(set)).not.toContain(butlerData);

    const stored = JSON.parse(
      readFileSync(join(butlerData, "personalization", "profile.json"), "utf8"),
    );
    expect(stored).toMatchObject(parsed.data.profile);

    const show = runCli(["personalization", "show", "--json"], butlerData);
    expect(show.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(show));
    expect(parsed.data.profile).toMatchObject({
      butler_nickname: "Alfred",
      principal_name: "Bruce Wayne",
      preferred_address: "Master Wayne",
    });
    expect(parsed.data.profiling).toMatchObject({
      mode: "off",
      enabled: false,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
    });
    expect(stdoutText(show)).not.toContain(butlerData);

    const profiling = runCli([
      "personalization",
      "set",
      "--profiling-mode",
      "deep",
      "--clear-profile",
      "--json",
    ], butlerData);
    expect(profiling.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(profiling));
    expect(parsed.data.profiling).toMatchObject({
      mode: "deep",
      enabled: true,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
    });
    expect(parsed.data.cleared_profile).toMatchObject({
      removed_candidates: 0,
      removed_stable_entries: 0,
      removed_runtime_projections: 0,
    });
    expect(stdoutText(profiling)).not.toContain(butlerData);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 15_000);

test("operator personalization migration prompt and off-mode import stay raw-text-free", () => {
  const butlerData = tempRoot();
  try {
    const prompt = runCli([
      "personalization",
      "migration",
      "prompt",
      "--locale",
      "ko",
      "--json",
    ], butlerData);
    expect(prompt.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(prompt));
    expect(parsed.data).toMatchObject({
      locale: "ko",
      raw_profile_included: false,
    });
    expect(parsed.data.prompt).toContain("저장한 모든 기억");
    expect(parsed.data.prompt).toContain("## Categories");
    expect(parsed.data.prompt).toContain("## Instructions");
    expect(parsed.data.prompt).toContain("[YYYY-MM-DD]");
    expect(parsed.data.prompt).toContain("완전한 전체 목록인지");
    expect(parsed.data.prompt).toContain("비밀번호");
    expect(parsed.data.prompt).not.toContain("Butler");

    const dumpPath = join(butlerData, "third-party-profile.json");
    writeFileSync(
      dumpPath,
      JSON.stringify({
        user_profile_export: {
          current_interests: ["raw migration sentinel"],
        },
      }),
      "utf8",
    );
    const imported = runCli([
      "personalization",
      "migration",
      "import",
      "--file",
      dumpPath,
      "--json",
    ], butlerData);
    expect(imported.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(imported));
    expect(parsed.data).toMatchObject({
      profiling_enabled: false,
      source: "external-ai",
      imported_candidate_count: 0,
      model_called: false,
      raw_text_included: false,
    });
    expect(stdoutText(imported)).not.toContain("raw migration sentinel");
    expect(stdoutText(imported)).not.toContain(dumpPath);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator model and auth commands use canonical refs and avoid secret leakage", () => {
  const butlerData = tempRoot();
  try {
    mkdirSync(join(butlerData, "auth"), { recursive: true });
    writeFileSync(join(butlerData, "auth", "openai-codex.json"), JSON.stringify({
      accessToken: "secret-access-token",
    }));

    const list = runCli(["model", "list", "--json"], butlerData);
    expect(list.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(list));
    expect(parsed.data.models[0]).toBe("openai/gpt-5.5-codex");
    expect(parsed.data.models).not.toContain("openai/auto:codex-latest");

    const set = runCli(["model", "set", "openai/gpt-5.5-codex", "--json"], butlerData);
    expect(set.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(set));
    expect(parsed.data.newModel).toBe("openai/gpt-5.5-codex");
    expect(JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8")).system.defaultModel).toBe("openai/gpt-5.5-codex");

    const logout = runCli(["auth", "logout", "--yes", "--json"], butlerData);
    expect(logout.exitCode).toBe(0);
    expect(stdoutText(logout)).not.toContain("secret-access-token");
    parsed = JSON.parse(stdoutText(logout));
    expect(parsed.data.removed).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator transport and Telegram commands are testable without live Telegram", () => {
  const butlerData = tempRoot();
  try {
    writeFileSync(join(butlerData, ".env"), [
      "TELEGRAM_BOT_TOKEN=123:secret",
      "TELEGRAM_CHAT_ID=456",
      "",
    ].join("\n"));

    const status = runCli(["transport", "status", "--json"], butlerData);
    expect(status.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(status));
    expect(parsed.data.transports.find((item: { id: string }) => item.id === "telegram")).toMatchObject({
      configured: true,
      paired: true,
    });
    expect(stdoutText(status)).not.toContain("123:secret");

    const mock = runCli(["transport", "test", "--transport", "mock", "--json"], butlerData);
    expect(mock.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(mock));
    expect(parsed.data.ok).toBe(true);

    const unpair = runCli(["telegram", "unpair", "--yes", "--json"], butlerData);
    expect(unpair.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(unpair));
    expect(parsed.data.removed).toBe(true);
    expect(readFileSync(join(butlerData, ".env"), "utf8")).not.toContain("TELEGRAM_CHAT_ID");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator work commands expose recovery state without raw prompts", () => {
  const butlerData = tempRoot();
  try {
    writeTask(butlerData, "task-running", {
      status: "RUNNING",
      request: "private prompt that should not be fully dumped",
    });
    writeTask(butlerData, "task-recoverable", {
      status: "RECOVERABLE",
      request: "continue interrupted architecture review",
    });
    writeTask(butlerData, "task-done", {
      status: "DONE",
      request: "finish report",
      result: "finished safely",
    });
    const queue = new TaskNotificationQueue(butlerData);
    queue.upsert({
      notificationId: "notification-failed",
      taskId: "task-done",
      taskStatus: "DONE",
      text: "safe report",
      status: "failed",
      createdAt: "2026-04-27T00:00:00.000Z",
      lastError: "temporary outage",
    });

    const dashboard = runCli(["work", "dashboard", "--json"], butlerData);
    expect(dashboard.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(dashboard));
    expect(parsed.data.counts.active).toBe(1);
    expect(parsed.data.counts.recoverable).toBe(1);
    expect(stdoutText(dashboard)).not.toContain("private prompt that should not be fully dumped");

    const recoverable = runCli(["work", "list", "--status", "RECOVERABLE", "--json"], butlerData);
    parsed = JSON.parse(stdoutText(recoverable));
    expect(parsed.data.items.map((item: { task_id: string }) => item.task_id)).toEqual(["task-recoverable"]);

    const resume = runCli(["work", "resume", "latest", "--json"], butlerData);
    expect(resume.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(resume));
    expect(parsed.data.intent.task_id).toBe("task-recoverable");

    const retry = runCli(["work", "retry", "notification-failed", "--json"], butlerData);
    expect(retry.exitCode).toBe(0);
    expect(queue.read("notification-failed")?.status).toBe("pending");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 15_000);

test("operator cognition memory, context, search, and web helpers return safe JSON envelopes", () => {
  const butlerData = tempRoot();
  try {
    const hotDir = join(butlerData, "cognition", "memory", "hot");
    mkdirSync(hotDir, { recursive: true });
    writeFileSync(join(hotDir, "cache.md"), "떡볶이 결정: 지난번에는 로제 떡볶이를 먹었다.\n", "utf8");
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      webSearch: {
        provider: "mock",
        readerBackend: "lightweight",
      },
    }));
    recordOperationalMetric({
      category: "cli",
      name: "operator-test",
      status: "ok",
      durationMs: 12,
      dimensions: {
        safeCount: 1,
        query: "must be sanitized",
      },
    }, { butlerData });

    const memoryStatus = runCli(["cognition", "memory", "status", "--json"], butlerData);
    expect(memoryStatus.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(memoryStatus));
    expect(parsed.data.hotCacheFiles).toBe(1);

    const memoryRecall = runCli(["cognition", "memory", "recall", "떡볶이", "--json"], butlerData);
    expect(memoryRecall.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(memoryRecall));
    expect(parsed.data.results[0]?.summary).toContain("떡볶이");
    expect(parsed.data.results[0]?.provenance[0]).toBe("cache.md#block-1");

    mkdirSync(join(butlerData, "cognition", "memory", "projects"), { recursive: true });
    writeFileSync(join(butlerData, "cognition", "memory", "projects", "butler.md"), [
      "# Project Memory: butler",
      "",
      "## Identity",
      "- project_id: butler",
      "",
      "## Freshness",
      "- source_counts: registry=0, tasks=0, explicit_feedback=0, project_hot_cache=0, memory_evidence=0, graph_evidence=0, promoted=0",
      "PRIVATE_CAPSULE_CONTENT",
    ].join("\n"), "utf8");
    const memoryInspect = runCli(["cognition", "memory", "project", "inspect", "butler", "--json"], butlerData);
    expect(memoryInspect.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(memoryInspect));
    expect(parsed.command).toBe("butler cognition memory project inspect");
    expect(parsed.data.sectionHeadings).toContain("Identity");
    expect(parsed.data.sourceCounts.promoted).toBe(0);
    expect(stdoutText(memoryInspect)).not.toContain("PRIVATE_CAPSULE_CONTENT");

    const contextStatus = runCli(["context", "status", "--json"], butlerData);
    expect(contextStatus.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(contextStatus));
    expect(parsed.data.thresholdState).toBeTruthy();

    const prune = runCli(["context", "prune", "--json"], butlerData);
    expect(prune.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(prune));
    expect(parsed.data.privacy.rawTextStored).toBe(false);

    const maintenance = runCli(["maintenance", "context", "--json"], butlerData);
    expect(maintenance.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(maintenance)).command).toBe("butler maintenance context");

    const tail = runCli(["metrics", "tail", "--json"], butlerData);
    expect(tail.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(tail));
    expect(parsed.data.events[0]?.dimensions.query).toBeUndefined();

    const search = runCli(["search", "test", "오늘 날씨", "--json"], butlerData);
    expect(search.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(search));
    expect(parsed.data.provider).toBe("mock");

    const url = `data:text/html,${encodeURIComponent("<html><head><title>Reader</title></head><body><main><h1>Reader</h1><p>Useful public content ".repeat(20) + "</p></main></body></html>")}`;
    const read = runCli(["web", "read", url, "--json"], butlerData);
    expect(read.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(read));
    expect(parsed.data.reader).toBe("butler-lightweight");
    expect(parsed.data.preview).toContain("Useful public content");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 10_000);

test("operator cognition feedback commands manage short-term feedback buffer", () => {
  const butlerData = tempRoot();
  try {
    const add = runCli([
      "cognition",
      "feedback",
      "add",
      "--text",
      "이제 bad-weather에서는 검색하지 마세요.",
      "--target",
      "source:bad-weather",
      "--category",
      "source_policy",
      "--scope",
      "source",
      "--promotion-target",
      "source_quality",
      "--json",
    ], butlerData);
    expect(add.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(add));
    const feedbackId = parsed.data.entry.feedback_id;
    expect(parsed.data.entry.status).toBe("active");

    const list = runCli(["cognition", "feedback", "list", "--json"], butlerData);
    expect(list.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(list));
    expect(parsed.data.entries.map((entry: { feedback_id: string }) => entry.feedback_id)).toEqual([feedbackId]);
    expect(stdoutText(list)).not.toContain("이제 bad-weather에서는 검색하지 마세요.");

    const show = runCli(["cognition", "feedback", "show", feedbackId, "--json"], butlerData);
    expect(show.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(show));
    expect(parsed.data.entry.text).toBe("이제 bad-weather에서는 검색하지 마세요.");

    const resolve = runCli(["cognition", "feedback", "resolve", feedbackId, "--status", "applied", "--json"], butlerData);
    expect(resolve.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(resolve));
    expect(parsed.data.entry.status).toBe("applied");

    const clear = runCli(["cognition", "feedback", "clear", "--applied", "--yes", "--json"], butlerData);
    expect(clear.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(clear));
    expect(parsed.data).toEqual({ removed: 1, remaining: 0 });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator cognition box commands expose manifest-backed index controls", () => {
  const butlerData = tempRoot();
  try {
    const manifest = createBoxItem(butlerData, {
      kind: "tool_result",
      title: "Box CLI item",
      summary: "Raw content should stay in content file.",
      tags: ["cli"],
      origin: { producer: "operator-test", session_id: "butler/main" },
      content: [{ filename: "payload.txt", data: "PRIVATE_RAW_BOX_PAYLOAD", mimeType: "text/plain" }],
    });

    const rebuild = runCli(["cognition", "box", "rebuild-index", "--json"], butlerData);
    expect(rebuild.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(rebuild));
    expect(parsed.data.indexed_count).toBe(1);

    const list = runCli(["cognition", "box", "list", "--json"], butlerData);
    expect(list.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(list));
    expect(parsed.data.items.map((item: { box_item_id: string }) => item.box_item_id)).toEqual([manifest.box_item_id]);
    expect(stdoutText(list)).not.toContain("PRIVATE_RAW_BOX_PAYLOAD");

    const show = runCli(["cognition", "box", "show", manifest.box_item_id, "--json"], butlerData);
    expect(show.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(show));
    expect(parsed.data.item.title).toBe("Box CLI item");
    expect(stdoutText(show)).not.toContain("PRIVATE_RAW_BOX_PAYLOAD");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator cognition user controls inspect forget disable repair without accidental raw leakage", () => {
  const butlerData = tempRoot();
  try {
    const manifest = createBoxItem(butlerData, {
      kind: "tool_result",
      title: "Operator control item",
      summary: "Safe manifest summary.",
      tags: ["controls"],
      origin: { producer: "operator-test", session_id: "butler/main" },
      content: [{ filename: "payload.txt", data: "PRIVATE_OPERATOR_CONTROL_PAYLOAD", mimeType: "text/plain" }],
    });
    const feedback = addFeedbackEntry(butlerData, {
      text: "이 소스는 다시 쓰지 마세요.",
      targetRef: "source:deprecated-source",
      category: "source_policy",
      scope: "source",
      promotionTarget: "source_quality",
    });
    const chunk = createMemoryChunk(butlerData, {
      scope: "global",
      summary: "Links can be inspected and repaired.",
      source: "operator-test",
      boxRefs: [
        { box_item_id: manifest.box_item_id, relation: "evidence" },
        { box_item_id: "box_missing", relation: "stale" },
      ],
      feedbackRefs: [
        { feedback_id: feedback.feedback_id, relation: "applied" },
        { feedback_id: "fb_missing", relation: "stale" },
      ],
    });
    const knowHow = createKnowHowEntry(butlerData, {
      name: "deprecated_source_lookup",
      aliases: ["deprecated"],
      status: "active",
      summary: "Use deprecated source.",
      intent_match: { topics: ["deprecated"], examples: ["deprecated lookup"] },
      strategy: { steps: ["fetch deprecated source"], preferred_sources: ["deprecated-source"] },
    });

    const inspectSafe = runCli(["cognition", "box", "inspect", manifest.box_item_id, "--json"], butlerData);
    expect(inspectSafe.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(inspectSafe));
    expect(parsed.data.raw).toEqual([]);
    expect(stdoutText(inspectSafe)).not.toContain("PRIVATE_OPERATOR_CONTROL_PAYLOAD");

    const inspectRaw = runCli(["cognition", "box", "inspect", manifest.box_item_id, "--include-raw", "--json"], butlerData);
    expect(inspectRaw.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(inspectRaw));
    expect(parsed.data.raw[0].text).toBe("PRIVATE_OPERATOR_CONTROL_PAYLOAD");

    const forget = runCli(["cognition", "box", "forget", manifest.box_item_id, "--mode", "raw", "--yes", "--json"], butlerData);
    expect(forget.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(forget));
    expect(parsed.data.mode).toBe("raw");
    const forgotten = readBoxManifest(butlerData, manifest.box_item_id);
    expect(forgotten?.status).toBe("forgotten");
    expect(forgotten?.quality.signals).toContain("forgotten:raw");
    const inspectForgottenRaw = runCli(["cognition", "box", "inspect", manifest.box_item_id, "--include-raw", "--json"], butlerData);
    expect(inspectForgottenRaw.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(inspectForgottenRaw));
    expect(parsed.data.raw[0].text).toBeNull();

    const disable = runCli(["cognition", "know-how", "disable", knowHow.knowhow_id, "--yes", "--json"], butlerData);
    expect(disable.exitCode).toBe(0);
    expect(readKnowHowEntry(butlerData, knowHow.knowhow_id)?.status).toBe("disabled");

    const check = runCli(["cognition", "memory", "metadata", "check", "--json"], butlerData);
    expect(check.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(check));
    expect(parsed.data.missing_box_refs).toEqual([{ memory_chunk_id: chunk.memory_chunk_id, box_item_id: "box_missing" }]);
    expect(parsed.data.missing_feedback_refs).toEqual([{ memory_chunk_id: chunk.memory_chunk_id, feedback_id: "fb_missing" }]);

    const repair = runCli(["cognition", "memory", "metadata", "repair-links", "--yes", "--json"], butlerData);
    expect(repair.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(repair));
    expect(parsed.data.repaired_box_refs).toBe(1);
    expect(parsed.data.repaired_feedback_refs).toBe(1);

    const inspectChunk = runCli(["cognition", "memory", "metadata", "inspect", chunk.memory_chunk_id, "--json"], butlerData);
    expect(inspectChunk.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(inspectChunk));
    expect(parsed.data.chunk.box_refs).toEqual([{ box_item_id: manifest.box_item_id, relation: "evidence" }]);
    expect(parsed.data.chunk.feedback_refs).toEqual([{ feedback_id: feedback.feedback_id, relation: "applied" }]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
}, 20_000);

test("operator cognition know-how commands expose retrieval quality and index controls", () => {
  const butlerData = tempRoot();
  try {
    const entry = createKnowHowEntry(butlerData, {
      name: "weather_source_lookup",
      aliases: ["weather"],
      status: "active",
      summary: "Use live weather source evidence.",
      intent_match: { topics: ["weather"], examples: ["today weather"] },
      strategy: { steps: ["fetch weather"], preferred_sources: ["open-meteo"] },
      quality: {
        score: 0.8,
        confidence: 0.7,
        success_count: 2,
        failure_count: 0,
        negative_feedback_count: 0,
        last_used_at: null,
        last_validated_at: null,
      },
    });
    recordSourceQualityEvent(butlerData, {
      source_id: "open-meteo",
      source_uri: "https://api.open-meteo.com",
      tool_name: "weather",
      observed_at: "2026-05-15T00:00:00.000Z",
      task_kind: "weather",
      freshness_score: 1,
      success: true,
      latency_ms: 100,
      user_feedback: "none",
      box_item_id: null,
      feedback_id: null,
      consolidation_run_id: null,
    });

    const retrieve = runCli(["cognition", "know-how", "retrieve", "today weather", "--json"], butlerData);
    expect(retrieve.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(retrieve));
    expect(parsed.data.selected.knowhow_id).toBe(entry.knowhow_id);

    const quality = runCli(["cognition", "know-how", "source-quality", "--json"], butlerData);
    expect(quality.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(quality));
    expect(parsed.data.summaries[0].source_id).toBe("open-meteo");

    const rebuild = runCli(["cognition", "know-how", "rebuild-index", "--json"], butlerData);
    expect(rebuild.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(rebuild));
    expect(parsed.data).toMatchObject({ indexed_count: 1, source_quality_count: 1 });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator cognition consolidation runs the generic cycle manually", () => {
  const butlerData = tempRoot();
  try {
    const run = runCli(["cognition", "consolidation", "run", "--manual", "--run-id", "cr_cli", "--json"], butlerData);
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText(run));
    expect(parsed.data.status).toBe("completed");
    expect(parsed.data.phases.map((phase: { phase: string }) => phase.phase)).toContain("box_index");
    expect(stdoutText(run)).not.toContain("PRIVATE");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator lifecycle commands require explicit confirmation for mutation", () => {
  const butlerData = tempRoot();
  const updateVersion = "99.0.0";
  try {
    const check = runCli(["update", "--component", "service", "--check", "--json"], butlerData);
    expect(check.exitCode).toBe(0);
    let parsed = JSON.parse(stdoutText(check));
    expect(parsed.data).toMatchObject({
      component: "service",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
      dryRun: false,
    });

    const artifactPath = join(butlerData, `butler-service-${updateVersion}.tar.gz`);
    const artifactContents = `service artifact v${updateVersion}`;
    writeFileSync(artifactPath, artifactContents, "utf8");
    const manifestPath = join(butlerData, "update-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      artifacts: [{
        component: "service",
        version: updateVersion,
        channel: "stable",
        artifact_url: artifactPath,
        sha256: createHash("sha256").update(artifactContents).digest("hex"),
        bundled_components: ["service"],
        update_policy: "explicit",
        restart_policy: "restart-service",
      }],
    }), "utf8");

    const dryRun = runCli(["update", "--dry-run", "--manifest", manifestPath, "--json"], butlerData);
    expect(dryRun.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(dryRun));
    expect(parsed.data.dryRun).toBe(true);
    expect(parsed.data.update_available).toBe(true);

    const apply = runCli(["update", "--apply", "--yes", "--manifest", manifestPath, "--json"], butlerData);
    expect(apply.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(apply));
    expect(parsed.data).toMatchObject({
      component: "service",
      current_version: packageVersion,
      available_version: updateVersion,
      update_available: true,
      dryRun: false,
      stage_status: "staged",
      stage_path: join("updates", "staged", "service.json"),
    });
    expect(existsSync(join(butlerData, "updates", "staged", "service.json"))).toBe(true);

    const uninstall = runCli(["uninstall", "--json"], butlerData);
    expect(uninstall.exitCode).toBe(2);
    expect(JSON.parse(stdoutText(uninstall)).error.code).toBe("invalid_arguments");

    const missingLogs = runCli(["logs", "--service", "missing", "--json"], butlerData);
    expect(missingLogs.exitCode).toBe(1);
    expect(JSON.parse(stdoutText(missingLogs)).error.code).toBe("not_found");

    const ps = runCli(["ps", "--json"], butlerData);
    expect(ps.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(ps)).data.source).toBeTruthy();
    expect(stderrText(ps)).not.toContain("secret");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("operator logs --follow streams appended safe lines", async () => {
  const butlerData = tempRoot();
  try {
    const logDir = join(butlerData, "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "butler-out.log");
    writeFileSync(logPath, "initial line\n", "utf8");

    const proc = Bun.spawn([
      "node",
      cli,
      "logs",
      "--service",
      "butler-main",
      "--lines",
      "1",
      "--follow",
      "--data",
      butlerData,
    ], {
      cwd: root,
      env: {
        ...process.env,
        BUTLER_DATA: butlerData,
        BUTLER_HOME: root,
        BUTLER_LOG_FOLLOW_POLL_MS: "25",
        BUTLER_LOG_FOLLOW_TEST_MS: "1000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let stdout = "";
    while (!stdout.includes("[butler-out.log] initial line")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value, { stream: true });
    }
    expect(stdout).toContain("[butler-out.log] initial line");

    writeFileSync(logPath, "next TELEGRAM_BOT_TOKEN=super-secret\n", {
      encoding: "utf8",
      flag: "a",
    });

    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value, { stream: true });
    }
    stdout += decoder.decode();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[butler-out.log] next TELEGRAM_BOT_TOKEN=[redacted]");
    expect(stdout).not.toContain("super-secret");
    expect(stderr).toBe("");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
