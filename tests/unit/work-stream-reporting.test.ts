import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import {
  completeReportingWorkStreamForSession,
  WorkStreamStore,
  type WorkStreamRecord,
} from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import type { ReportingCompletionFault, ReportingCompletionJournal } from "../../packages/butler-agent/src/agent/work/work-stream-reporting-store.ts";
import { workStreamMutationLockPath } from "../../packages/butler-agent/src/agent/work/work-stream-mutation-authority.ts";

let data = "";

beforeEach(() => {
  data = join(tmpdir(), `butler-reporting-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});

afterEach(() => rmSync(data, { recursive: true, force: true }));

for (const faultAt of ["after_prepare", "after_todo_write", "after_workstream_write"] as ReportingCompletionFault[]) {
  test(`reporting completion auto-recovers after ${faultAt}`, async () => {
    const record = createReportingWorkStream();
    expect(() => completeReportingWorkStreamForSession({
      butlerData: data,
      sessionId: "session-reporting",
      statusNote: "Delivered with evidence.",
      now: new Date("2026-07-10T10:00:00.000Z"),
      faultAt,
    })).toThrow(`injected_reporting_completion_fault:${faultAt}`);

    const rawWorkstream = readWorkStream(record.id);
    const rawTodo = new TodoListStore(data, { autoRecover: false }).read("reporting-list");
    expect(rawWorkstream?.state).toBe(faultAt === "after_workstream_write" ? "complete" : "reporting");
    expect(rawTodo?.items.find((item) => item.id === "report")?.status)
      .toBe(faultAt === "after_prepare" ? "in_progress" : "completed");

    const recovered = await waitForRecovered(record.id);
    expect(recovered).toMatchObject({ state: "complete", current_phase: null, active_step_id: null });
    expect(new TodoListStore(data).read("reporting-list")?.items.find((item) => item.id === "report"))
      .toMatchObject({ status: "completed", note: "Delivered with evidence." });
    const journal = readReportingJournal();
    expect(journal.state).toBe("committed");
    expect(journal.before_workstream_fingerprint).not.toBe(journal.after_workstream_fingerprint);
    expect(journal.before_todo_fingerprint).not.toBe(journal.after_todo_fingerprint);
  });
}

test("reporting completion lock conflict leaves todo and WorkStream byte-identical", async () => {
  const record = createReportingWorkStream();
  const workstreamPath = join(data, "work-streams", `${record.id}.json`);
  const todoPath = join(data, "todos", "reporting-list.json");
  const beforeWorkstream = readFileSync(workstreamPath, "utf8");
  const beforeTodo = readFileSync(todoPath, "utf8");
  const logPath = join(data, "reporting-holder.jsonl");
  const fixture = join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts");
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      fixture,
      workStreamMutationLockPath(data, record.id),
      logPath,
      "reporting-holder",
      "30000",
      "30000",
      data,
    ],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitForEntry(logPath);
  const startedAt = performance.now();
  expect(completeReportingWorkStreamForSession({ butlerData: data, sessionId: "session-reporting" })).toBeNull();
  expect(performance.now() - startedAt).toBeLessThan(250);
  expect(readFileSync(workstreamPath, "utf8")).toBe(beforeWorkstream);
  expect(readFileSync(todoPath, "utf8")).toBe(beforeTodo);
  expect(existsSync(join(data, "workstream-reporting-transactions"))).toBe(false);
  holder.kill("SIGKILL");
  await holder.exited;
}, 30_000);

test("deferred reporting recovery retries asynchronously after the owner exits", async () => {
  const record = createReportingWorkStream();
  expect(() => completeReportingWorkStreamForSession({
    butlerData: data,
    sessionId: "session-reporting",
    faultAt: "after_prepare",
  })).toThrow("injected_reporting_completion_fault:after_prepare");
  const logPath = join(data, "deferred-holder.jsonl");
  const holder = spawnHolder(record.id, logPath);
  await waitForEntry(logPath);
  const startedAt = performance.now();
  expect(new WorkStreamStore(data).read(record.id)?.state).toBe("reporting");
  expect(performance.now() - startedAt).toBeLessThan(250);
  expect(readReportingJournal().state).toBe("prepared");
  holder.kill("SIGKILL");
  await holder.exited;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && readReportingJournal().state !== "committed") await Bun.sleep(10);
  expect(readReportingJournal().state).toBe("committed");
  expect(readWorkStream(record.id)?.state).toBe("complete");
}, 30_000);

test("deferred after_todo_write exposes before-images and rejects public writes", async () => {
  const record = createReportingWorkStream();
  expect(() => completeReportingWorkStreamForSession({
    butlerData: data,
    sessionId: "session-reporting",
    faultAt: "after_todo_write",
  })).toThrow("injected_reporting_completion_fault:after_todo_write");
  const rawTodoBefore = readFileSync(join(data, "todos", "reporting-list.json"), "utf8");
  const rawWorkstreamBefore = readFileSync(join(data, "work-streams", `${record.id}.json`), "utf8");
  expect(JSON.parse(rawTodoBefore).items.find((item: { id: string }) => item.id === "report")?.status).toBe("completed");
  expect(JSON.parse(rawWorkstreamBefore).state).toBe("reporting");

  const logPath = join(data, "deferred-after-todo-holder.jsonl");
  const holder = spawnHolder(record.id, logPath);
  await waitForEntry(logPath);

  expect(new TodoListStore(data).read("reporting-list")?.items.find((item) => item.id === "report")?.status)
    .toBe("in_progress");
  expect(new WorkStreamStore(data).read(record.id)?.state).toBe("reporting");
  expect(() => new TodoListStore(data).update({
    listId: "reporting-list",
    items: [
      { id: "implementation", content: "Implement", active_form: "Implementing", status: "completed", phase: "execution" },
      { id: "report", content: "Report changed", active_form: "Reporting", status: "in_progress", phase: "reporting" },
    ],
  })).toThrow("workstream_recovery_deferred");
  expect(() => new WorkStreamStore(data).transition({ id: record.id, state: "recoverable" }))
    .toThrow("workstream_recovery_deferred");
  expect(readFileSync(join(data, "todos", "reporting-list.json"), "utf8")).toBe(rawTodoBefore);
  expect(readFileSync(join(data, "work-streams", `${record.id}.json`), "utf8")).toBe(rawWorkstreamBefore);

  holder.kill("SIGKILL");
  await holder.exited;
  const recovered = await waitForRecovered(record.id);
  expect(recovered.state).toBe("complete");
}, 30_000);

test("deferred after_workstream_write keeps list projections on the before-image", async () => {
  const record = createReportingWorkStream();
  expect(() => completeReportingWorkStreamForSession({
    butlerData: data,
    sessionId: "session-reporting",
    faultAt: "after_workstream_write",
  })).toThrow("injected_reporting_completion_fault:after_workstream_write");
  expect(readWorkStream(record.id)?.state).toBe("complete");

  const logPath = join(data, "deferred-after-workstream-holder.jsonl");
  const holder = spawnHolder(record.id, logPath);
  await waitForEntry(logPath);
  const store = new WorkStreamStore(data);
  expect(store.read(record.id)?.state).toBe("reporting");
  expect(store.listActive({ sessionId: "session-reporting" }).map((item) => item.id)).toContain(record.id);

  holder.kill("SIGKILL");
  await holder.exited;
  expect((await waitForRecovered(record.id)).state).toBe("complete");
}, 30_000);

function createReportingWorkStream(): WorkStreamRecord {
  const todoRecord = new TodoListStore(data).update({
    listId: "reporting-list",
    title: "Reporting transaction",
    items: [
      { id: "implementation", content: "Implement", active_form: "Implementing", status: "completed", phase: "execution" },
      { id: "report", content: "Report", active_form: "Reporting", status: "in_progress", phase: "reporting" },
    ],
    now: new Date("2026-07-10T09:00:00.000Z"),
  }).list;
  return new WorkStreamStore(data).updateFromTodoList({
    ownerSessionId: "session-reporting",
    projectId: "project-reporting",
    listId: todoRecord.list_id,
    title: todoRecord.title,
    items: todoRecord.items,
    now: new Date("2026-07-10T09:00:00.000Z"),
  });
}

function readWorkStream(id: string): WorkStreamRecord | null {
  return JSON.parse(readFileSync(join(data, "work-streams", `${id}.json`), "utf8")) as WorkStreamRecord;
}

function readReportingJournal(): ReportingCompletionJournal {
  const dir = join(data, "workstream-reporting-transactions");
  const name = readdirSync(dir).find((entry) => entry.endsWith(".json"));
  if (!name) throw new Error("reporting journal missing");
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as ReportingCompletionJournal;
}

async function waitForRecovered(workstreamId: string): Promise<WorkStreamRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = new WorkStreamStore(data).read(workstreamId);
    if (record?.state === "complete" && readReportingJournal().state === "committed") return record;
    await Bun.sleep(10);
  }
  throw new Error("reporting recovery timed out");
}

async function waitForEntry(logPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((!existsSync(logPath) || !readFileSync(logPath, "utf8").includes('"event":"enter"')) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(readFileSync(logPath, "utf8")).toContain('"event":"enter"');
}

function spawnHolder(workstreamId: string, logPath: string) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts"),
      workStreamMutationLockPath(data, workstreamId),
      logPath,
      "deferred-holder",
      "30000",
      "30000",
      data,
    ],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "inherit",
  });
}
