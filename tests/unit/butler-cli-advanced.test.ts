import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AutomationStore } from "../../packages/butler-agent/src/operations/service/automation-store.ts";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cli-advanced-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string[], butlerData: string) {
  return Bun.spawnSync(["node", cli, ...args, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_DATA: butlerData,
      BUTLER_HOME: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

function writeTranscript(butlerData: string, sessionId: string): void {
  const transcriptDir = join(butlerData, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  const path = join(transcriptDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  const events = [
    {
      eventId: "evt-1",
      sessionId,
      kind: "inbound",
      timestamp: "2026-04-27T00:00:00.000Z",
      payload: {
        message: {
          text: "private conversation text should not be printed",
        },
      },
    },
    {
      eventId: "evt-2",
      sessionId,
      kind: "outbound",
      timestamp: "2026-04-27T00:00:01.000Z",
      payload: {
        message: {
          text: "summarized response should also stay hidden",
        },
      },
    },
  ];
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

test("advanced cognition memory ingest dry-run reports counts without raw transcript text", () => {
  const butlerData = tempRoot();
  try {
    writeTranscript(butlerData, "butler/main");

    const result = runCli(["cognition", "memory", "ingest", "--session", "butler/main", "--dry-run", "--json"], butlerData);

    expect(result.exitCode).toBe(0);
    expect(stdoutText(result)).not.toContain("private conversation text");
    expect(stdoutText(result)).not.toContain("summarized response");
    const parsed = JSON.parse(stdoutText(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("butler cognition memory ingest");
    expect(parsed.data).toMatchObject({
      dryRun: true,
      sessionId: "butler/main",
      messages: 2,
      chunks: 1,
      rawTextIncluded: false,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("advanced cognition memory maintain emits safe maintenance summary", () => {
  const butlerData = tempRoot();
  try {
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      cognition: {
        consolidationCycle: {
          enabled: false,
        },
      },
    }));

    const result = runCli(["cognition", "memory", "maintain", "--json"], butlerData);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText(result));
    expect(parsed.command).toBe("butler cognition memory maintain");
    expect(parsed.data.skipped).toBe(true);
    expect(parsed.data.rawTextIncluded).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("advanced automation commands list show run and tombstone safely", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);
  try {
    const longPrompt = `Very private automation prompt ${"x".repeat(240)}`;
    store.create({
      id: "morning-brief",
      title: "Morning brief",
      prompt: longPrompt,
      sessionId: "butler/main",
      schedule: {
        type: "once",
        run_at: "2026-04-27T08:00:00.000Z",
      },
      now: new Date("2026-04-27T07:00:00.000Z"),
    });

    const list = runCli(["automation", "list", "--json"], butlerData);
    expect(list.exitCode).toBe(0);
    expect(stdoutText(list)).not.toContain(longPrompt);
    let parsed = JSON.parse(stdoutText(list));
    expect(parsed.data.automations[0]).toMatchObject({
      id: "morning-brief",
      status: "active",
    });
    expect(parsed.data.automations[0].prompt_preview.length).toBeLessThanOrEqual(160);

    const show = runCli(["automation", "show", "morning-brief", "--json"], butlerData);
    expect(show.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(show));
    expect(parsed.data.automation.id).toBe("morning-brief");

    const run = runCli(["automation", "run", "morning-brief", "--json"], butlerData);
    expect(run.exitCode).toBe(0);
    expect(stdoutText(run)).not.toContain(longPrompt);
    parsed = JSON.parse(stdoutText(run));
    expect(parsed.data.automation.status).toBe("completed");
    expect(parsed.data.envelope.messageTextIncluded).toBe(false);

    const deleteWithoutConfirmation = runCli(["automation", "delete", "morning-brief", "--json"], butlerData);
    expect(deleteWithoutConfirmation.exitCode).toBe(2);

    const remove = runCli(["automation", "delete", "morning-brief", "--yes", "--json"], butlerData);
    expect(remove.exitCode).toBe(0);
    parsed = JSON.parse(stdoutText(remove));
    expect(parsed.data.automation.status).toBe("deleted");

    const listAfterDelete = runCli(["automation", "list", "--json"], butlerData);
    expect(JSON.parse(stdoutText(listAfterDelete)).data.automations).toEqual([]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("deferred todo and automation pause resume commands remain unavailable", () => {
  const butlerData = tempRoot();
  try {
    for (const args of [
      ["todo", "list", "--json"],
      ["automation", "pause", "x", "--json"],
      ["automation", "resume", "x", "--json"],
    ]) {
      const result = runCli(args, butlerData);
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(stdoutText(result));
      expect(parsed.error.code).toBe("feature_not_stable");
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("automation store can manually run active automations", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);
  try {
    store.create({
      id: "manual-run",
      prompt: "Run this manually.",
      sessionId: "butler/main",
      schedule: {
        type: "interval",
        interval_minutes: 60,
        start_at: "2026-04-27T08:00:00.000Z",
      },
      now: new Date("2026-04-27T07:00:00.000Z"),
    });

    const run = store.runNow("manual-run", new Date("2026-04-27T08:15:00.000Z"));

    expect(run.automation).toMatchObject({
      id: "manual-run",
      status: "active",
      run_count: 1,
      next_run_at: "2026-04-27T09:00:00.000Z",
    });
    expect(store.read("manual-run")?.run_count).toBe(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
