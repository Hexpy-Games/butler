import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ElectronScenario,
  GuidedWorkObservation,
} from "../e2e/btcc-r3-electron/contracts.ts";
import { prepareElectronRun } from
  "../e2e/btcc-r3-electron/isolation-config.ts";
import { openSession } from
  "../e2e/btcc-r3-electron/product-launch.ts";
import { checkScenarioExpectations } from
  "../e2e/btcc-r3-electron/scenario-expectations.ts";
import { readElectronScenario } from
  "../e2e/btcc-r3-electron/scenario-preflight.ts";
import { readGuidedWorkObservation } from
  "../e2e/btcc-r3-electron/work-evidence.ts";

const PROJECT_SCENARIO_PATH = join(
  import.meta.dir,
  "..",
  "e2e",
  "btcc-r3-electron-project-effect-scenario.json",
);

test("project Electron scenario prepares an isolated scratch root without changing chat defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-r3-electron-project-harness-"));
  const sourceData = join(root, "source-data");
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(
    join(sourceData, "butler.config.json"),
    `${JSON.stringify({
      models: { registered: [] },
      system: {
        butlerModel: "local/test-model",
        defaultModel: "local/test-model",
      },
    })}\n`,
    "utf8",
  );

  try {
    const projectScenario = readElectronScenario(PROJECT_SCENARIO_PATH);
    const projectRun = await prepareElectronRun(projectScenario, {
      dryRun: true,
      model: "local/test-model",
      runRoot: join(root, "project-run"),
      sourceData,
    });
    expect(projectRun.sessionKind).toBe("project");
    expect(projectRun.projectId).toBeNull();
    expect(projectRun.workspaceRoot).toBe(projectRun.projectWorkspaceRoot);
    expect(projectRun.projectWorkspaceRoot.startsWith(projectRun.dataRoot)).toBe(true);

    const chatScenario: ElectronScenario = {
      schema: "butler.btcc-r3-electron-scenario.v1",
      id: "chat-default-regression",
      steps: [{ id: "hello", prompt: "hello" }],
    };
    const chatRun = await prepareElectronRun(chatScenario, {
      dryRun: true,
      model: "local/test-model",
      runRoot: join(root, "chat-run"),
      sourceData,
    });
    expect(chatRun.sessionKind).toBe("chat");
    expect(chatRun.projectId).toBeNull();
    expect(chatRun.workspaceRoot).toBe(join(chatRun.runRoot, "workspace"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project Electron navigation selects the session row when project and session titles match", async () => {
  const clicks: Array<[string, string]> = [];
  let projectSessionVisible = false;
  const page = {
    async waitForNamedElement() {},
    async namedElementVisible() {
      return projectSessionVisible;
    },
    async clickNamedElement(selector: string, name: string) {
      clicks.push([selector, name]);
      if (selector === '[data-test-class="project-group-row"]') {
        projectSessionVisible = true;
      }
    },
    async waitForNamedElementCurrent() {},
    async waitFor() {},
    async evaluate() {
      return {
        session_id: "project-session",
        kind: "project",
        project_id: "project-1",
      };
    },
  };
  const run = {
    projectDisplayName: "Same title",
    projectId: "project-1",
    sessionId: "project-session",
    sessionKind: "project",
    sessionTitle: "Same title",
  } as Parameters<typeof openSession>[0];

  await openSession(
    run,
    page as unknown as Parameters<typeof openSession>[1],
  );

  expect(clicks).toEqual([
    ['[data-test-class="project-group-row"]', "Same title"],
    ['[data-test-class="project-session-row"]', "Same title"],
  ]);
});

test("project effect scenario requires typed-effect Work evidence and persisted marker", async () => {
  const scenario = readElectronScenario(PROJECT_SCENARIO_PATH);
  const [createStep, readStep] = scenario.steps;
  expect(createStep).toBeDefined();
  expect(readStep).toBeDefined();
  const work: GuidedWorkObservation = {
    workId: "work-runtime-owned",
    status: "completed",
    planRevision: 1,
    checkpointStage: "review",
    planReviewVerdict: "accept",
    resultReviewVerdict: "accept",
    resultToolNames: ["project_ledger_create", "project_ledger_show"],
    projectLedgerWorkRecords: 0,
    projectLedgerCompletedWorkRecords: 0,
    projectLedgerCloseoutObserved: false,
  };
  const run = {
    workspaceRoot: "/isolated/workspace",
  } as Parameters<typeof checkScenarioExpectations>[0];

  const created = checkScenarioExpectations(
    run,
    createStep!,
    "delivered",
    [
      "SPEC-BTCC-R3-E2E-PROJECT-EFFECT",
      "BTCC_R3_PROJECT_LEDGER_EFFECT_MARKER_20260731",
    ].join(" "),
    work,
    new Map(),
  );
  expect(created).toEqual({ passed: true, failures: [] });

  const missingEffect = checkScenarioExpectations(
    run,
    createStep!,
    "delivered",
    [
      "SPEC-BTCC-R3-E2E-PROJECT-EFFECT",
      "BTCC_R3_PROJECT_LEDGER_EFFECT_MARKER_20260731",
    ].join(" "),
    { ...work, resultToolNames: ["project_ledger_show"] },
    new Map(),
  );
  expect(missingEffect.failures).toContain(
    "work_result_tool_missing:project_ledger_create",
  );

  const closeoutStep = {
    ...createStep!,
    expect: {
      ...createStep!.expect,
      work: {
        ...createStep!.expect?.work,
        projectLedgerCloseout: true,
      },
    },
  };
  expect(checkScenarioExpectations(
    run,
    closeoutStep,
    "delivered",
    [
      "SPEC-BTCC-R3-E2E-PROJECT-EFFECT",
      "BTCC_R3_PROJECT_LEDGER_EFFECT_MARKER_20260731",
    ].join(" "),
    work,
    new Map(),
  ).failures).toContain(
    "project_ledger_closeout:false:expected:true",
  );

  const missingPersistedMarker = checkScenarioExpectations(
    run,
    readStep!,
    "delivered",
    "SPEC-BTCC-R3-E2E-PROJECT-EFFECT",
    null,
    new Map(),
  );
  expect(missingPersistedMarker.failures).toContain(
    "final_missing:BTCC_R3_PROJECT_LEDGER_EFFECT_MARKER_20260731",
  );
});

test("Electron Work evidence preserves the effective project_ledger_create tool name", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-r3-electron-work-evidence-"));
  const appDbDir = join(root, "app-server");
  const appDbPath = join(appDbDir, "butler-client.sqlite");
  mkdirSync(appDbDir, { recursive: true });
  const db = new Database(appDbPath);
  try {
    db.exec(`
      CREATE TABLE btcc_guided_works (
        work_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_plan_revision_id TEXT
      );
      CREATE TABLE btcc_guided_turn_work_bindings (
        turn_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        is_current INTEGER NOT NULL
      );
      CREATE TABLE btcc_guided_work_plan_revisions (
        plan_revision_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE btcc_guided_work_checkpoint_revisions (
        work_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        stage TEXT NOT NULL
      );
      CREATE TABLE btcc_guided_work_review_revisions (
        work_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        subject TEXT NOT NULL,
        verdict TEXT NOT NULL
      );
      CREATE TABLE btcc_guided_tool_calls (
        call_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE btcc_guided_effects (
        receipt_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        sanitized_target TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE btcc_guided_work_results (
        work_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      INSERT INTO btcc_guided_works
        VALUES ('work-1', 'completed', 'plan-1');
      INSERT INTO btcc_guided_turn_work_bindings
        VALUES ('turn-1', 'work-1', 1);
      INSERT INTO btcc_guided_work_plan_revisions
        VALUES ('plan-1', 'work-1', 1);
      INSERT INTO btcc_guided_work_checkpoint_revisions
        VALUES ('work-1', 1, 'review');
      INSERT INTO btcc_guided_work_review_revisions
        VALUES ('work-1', 1, 'plan', 'accept');
      INSERT INTO btcc_guided_work_review_revisions
        VALUES ('work-1', 2, 'result', 'accept');
      INSERT INTO btcc_guided_tool_calls
        VALUES ('call-1', 'turn-1', 'project_ledger_create', 'completed', '{"ok":true}');
      INSERT INTO btcc_guided_tool_calls VALUES (
        'call-2', 'turn-1', 'project_ledger_work_complete', 'completed',
        '{"ok":true,"effect_receipt":{"receipt_id":"receipt-2"}}'
      );
      INSERT INTO btcc_guided_effects VALUES (
        'receipt-2', 'work-1', 'project_ledger_work_complete',
        'project-ledger:work:W-FIXTURE', 'applied'
      );
      INSERT INTO btcc_guided_work_results
        VALUES ('work-1', 'call-1', 1);
      INSERT INTO btcc_guided_work_results
        VALUES ('work-1', 'call-2', 2);
    `);
  } finally {
    db.close();
  }

  try {
    const projectWorkDir = join(
      root,
      "project-ledger",
      "projects",
      "fixture",
      "work",
      "W-FIXTURE",
    );
    mkdirSync(projectWorkDir, { recursive: true });
    const projectWorkPath = join(projectWorkDir, "work.md");
    writeFileSync(projectWorkPath, [
      "---",
      'id: "W-FIXTURE"',
      'status: "in_progress"',
      "---",
      "",
    ].join("\n"));
    const observed = readGuidedWorkObservation(
      { dataRoot: root, projectId: "fixture" } as Parameters<
        typeof readGuidedWorkObservation
      >[0],
      "turn-1",
    );
    expect(observed).toMatchObject({
      status: "completed",
      planRevision: 1,
      planReviewVerdict: "accept",
      resultReviewVerdict: "accept",
      resultToolNames: ["project_ledger_create", "project_ledger_work_complete"],
      projectLedgerWorkRecords: 1,
      projectLedgerCompletedWorkRecords: 0,
      projectLedgerCloseoutObserved: false,
    });
    const unrelatedProjectWorkDir = join(
      root,
      "project-ledger",
      "projects",
      "fixture",
      "work",
      "W-UNRELATED",
    );
    mkdirSync(unrelatedProjectWorkDir, { recursive: true });
    writeFileSync(join(unrelatedProjectWorkDir, "work.md"), [
      "---",
      'id: "W-UNRELATED"',
      'status: "done"',
      "---",
      "",
    ].join("\n"));
    const sameIdOtherProjectWorkDir = join(
      root,
      "project-ledger",
      "projects",
      "other-project",
      "work",
      "W-FIXTURE",
    );
    mkdirSync(sameIdOtherProjectWorkDir, { recursive: true });
    writeFileSync(join(sameIdOtherProjectWorkDir, "work.md"), [
      "---",
      'id: "W-FIXTURE"',
      'status: "done"',
      "---",
      "",
    ].join("\n"));
    expect(readGuidedWorkObservation(
      { dataRoot: root, projectId: "fixture" } as Parameters<
        typeof readGuidedWorkObservation
      >[0],
      "turn-1",
    )).toMatchObject({
      projectLedgerWorkRecords: 2,
      projectLedgerCompletedWorkRecords: 0,
      projectLedgerCloseoutObserved: false,
    });
    writeFileSync(projectWorkPath, [
      "---",
      'id: "W-FIXTURE"',
      'status: "done"',
      "---",
      "",
    ].join("\n"));
    expect(readGuidedWorkObservation(
      { dataRoot: root, projectId: "fixture" } as Parameters<
        typeof readGuidedWorkObservation
      >[0],
      "turn-1",
    )).toMatchObject({
      projectLedgerWorkRecords: 2,
      projectLedgerCompletedWorkRecords: 1,
      projectLedgerCloseoutObserved: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
