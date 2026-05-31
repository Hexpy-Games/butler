import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AutomationStore } from "../../packages/butler-agent/src/operations/service/automation-store.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-automation-store-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("one-shot automations persist under Butler data and complete after claim", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);

  try {
    const created = store.create({
      id: "daily-brief",
      title: "Daily brief",
      prompt: "Prepare the morning brief with calendar and project risks.",
      sessionId: "butler/main",
      schedule: {
        type: "once",
        run_at: "2026-04-27T08:00:00.000Z",
      },
      now: new Date("2026-04-27T07:00:00.000Z"),
    });

    expect(existsSync(join(butlerData, "automations", "daily-brief.json"))).toBe(true);
    expect(created.prompt_preview).toBe("Prepare the morning brief with calendar and project risks.");

    const pending = store.claimDue(new Date("2026-04-27T07:59:59.000Z"));
    expect(pending).toEqual([]);

    const due = store.claimDue(new Date("2026-04-27T08:00:00.000Z"));
    expect(due).toHaveLength(1);
    expect(due[0]?.envelope).toMatchObject({
      transport: "automation",
      accountId: "local",
      message: {
        text: "Prepare the morning brief with calendar and project risks.",
      },
      routingHints: {
        sessionId: "butler/main",
      },
    });

    const completed = store.read("daily-brief");
    expect(completed).toMatchObject({
      status: "completed",
      next_run_at: null,
      run_count: 1,
      last_run_at: "2026-04-27T08:00:00.000Z",
    });
    expect(store.claimDue(new Date("2026-04-27T08:00:01.000Z"))).toEqual([]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("interval automations advance next run after each claim", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);

  try {
    store.create({
      id: "hourly-check",
      title: "Hourly check",
      prompt: "Check active work and summarize only blockers.",
      sessionId: "butler/main",
      schedule: {
        type: "interval",
        interval_minutes: 60,
        start_at: "2026-04-27T08:00:00.000Z",
      },
      now: new Date("2026-04-27T07:00:00.000Z"),
    });

    const first = store.claimDue(new Date("2026-04-27T08:00:00.000Z"));
    expect(first).toHaveLength(1);
    expect(store.read("hourly-check")).toMatchObject({
      status: "active",
      next_run_at: "2026-04-27T09:00:00.000Z",
      run_count: 1,
    });

    const second = store.claimDue(new Date("2026-04-27T10:30:00.000Z"));
    expect(second).toHaveLength(1);
    expect(store.read("hourly-check")).toMatchObject({
      status: "active",
      next_run_at: "2026-04-27T11:00:00.000Z",
      run_count: 2,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("automation ids cannot be overwritten and old intervals advance without loops", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);

  try {
    store.create({
      id: "stable-id",
      prompt: "Run the recurring long-range maintenance check.",
      sessionId: "butler/main",
      schedule: {
        type: "interval",
        interval_minutes: 30,
        start_at: "2020-01-01T00:00:00.000Z",
      },
      now: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(() => store.create({
      id: "stable-id",
      prompt: "Overwrite attempt.",
      sessionId: "butler/main",
      schedule: {
        type: "once",
        run_at: "2026-04-27T08:00:00.000Z",
      },
    })).toThrow("automation stable-id already exists");

    const [claimed] = store.claimDue(new Date("2026-04-27T08:15:00.000Z"));
    expect(claimed?.automation).toMatchObject({
      id: "stable-id",
      status: "active",
      next_run_at: "2026-04-27T08:30:00.000Z",
      run_count: 1,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("automation listing uses previews and delete hides records by default", () => {
  const butlerData = tempRoot();
  const store = new AutomationStore(butlerData);
  const longPrompt = `Secret detail ${"x".repeat(220)}`;

  try {
    store.create({
      id: "preview-test",
      prompt: longPrompt,
      sessionId: "butler/main",
      schedule: {
        type: "once",
        run_at: "2026-04-27T08:00:00.000Z",
      },
    });

    const listed = store.list();
    expect(listed[0]?.prompt_preview.length).toBeLessThanOrEqual(160);
    expect(listed[0]?.prompt_preview).not.toBe(longPrompt);

    store.delete("preview-test", new Date("2026-04-27T08:00:00.000Z"));
    expect(store.list()).toEqual([]);
    expect(store.list({ includeDeleted: true })[0]).toMatchObject({
      id: "preview-test",
      status: "deleted",
      next_run_at: null,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
