import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer as createAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { WORKER_PROFILE_ID_PATTERN } from "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";

let tempDir = "";
let originalButlerData: string | undefined;
let originalButlerHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-worker-profile-settings-"));
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_HOME = process.cwd();
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalButlerHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function createServer(dbName: string) {
  return createAppServer({
    dbPath: join(tempDir, dbName),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
}

async function getSettings(url: string) {
  const response = await fetch(`${url}settings`);
  expect(response.ok).toBe(true);
  const body = await response.json();
  return body.data as Record<string, unknown>;
}

async function patchSettings(
  url: string,
  body: unknown,
): Promise<{ status: number; data?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const response = await fetch(`${url}settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return {
    status: response.status,
    data: json.data as Record<string, unknown> | undefined,
    error: json.error as Record<string, unknown> | undefined,
  };
}

function readPersistedSettings(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ value_json: string }, [string]>(
        "SELECT value_json FROM app_settings WHERE key = ?",
      )
      .get("settings");
    if (!row) throw new Error("settings row missing");
    return JSON.parse(row.value_json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function readPersistedSettingsRow(
  dbPath: string,
): { value_json: string; updated_at: string } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ value_json: string; updated_at: string }, [string]>(
        "SELECT value_json, updated_at FROM app_settings WHERE key = ?",
      )
      .get("settings");
    if (!row) throw new Error("settings row missing");
    return row;
  } finally {
    db.close();
  }
}

function stampPersistedUpdatedAt(dbPath: string, updatedAt: string): void {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE app_settings SET updated_at = ? WHERE key = ?").run(
      updatedAt,
      "settings",
    );
  } finally {
    db.close();
  }
}

function writePersistedSettings(dbPath: string, value: unknown): void {
  const db = new Database(dbPath);
  try {
    db.query(
      `
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
    ).run("settings", JSON.stringify(value), new Date().toISOString());
  } finally {
    db.close();
  }
}

const DEFAULT_PROFILE_BASE = {
  id: "default",
  label: "Default",
  job: { kind: "builtin", job: "coding" },
};

function defaultProfile(
  model: string,
  reasoningEffort: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...DEFAULT_PROFILE_BASE,
    enabled: true,
    model,
    reasoning_effort: reasoningEffort,
    ...overrides,
  };
}

test("fresh settings expose exactly one complete enabled default worker profile with max workers", async () => {
  const dbName = "fresh-settings.sqlite";
  const dbPath = join(tempDir, dbName);
  const server = createServer(dbName);
  try {
    const settings = await getSettings(server.url);
    const profiles = settings.worker_profiles as Array<Record<string, unknown>>;
    const maxWorkers = settings.max_simultaneous_workers as number;

    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles).toHaveLength(1);
    expect(maxWorkers).toBe(10);

    const [defaultProfileRow] = profiles;
    expect(defaultProfileRow).toEqual({
      id: "default",
      label: "Default",
      enabled: true,
      job: { kind: "builtin", job: "coding" },
      model: settings.model,
      reasoning_effort: settings.reasoning_effort,
    });
    expect(typeof defaultProfileRow?.model).toBe("string");
    expect((defaultProfileRow?.model as string).length).toBeGreaterThan(0);
    expect(typeof defaultProfileRow?.reasoning_effort).toBe("string");

    const persisted = readPersistedSettings(dbPath);
    expect(persisted.worker_profiles).toEqual(profiles);
    expect(persisted.max_simultaneous_workers).toBe(10);
    expect(Object.keys(persisted)).not.toContain("worker_model_rules");
  } finally {
    server.stop();
  }
});

test("legacy persisted worker_model_rules migrate deterministically and purge the legacy key", async () => {
  const dbPath = join(tempDir, "legacy-migration.sqlite");
  const bootstrap = createServer("legacy-migration.sqlite");
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    worker_model_rules: [
      {
        id: "deep_work",
        label: "Deep work",
        condition: "Research  and   review",
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        enabled: false,
      },
      {
        label: "Routine",
        condition: "",
        model: "unknown/model",
        reasoning_effort: "max",
        enabled: true,
      },
      {
        id: "Deep Work",
        label: "Dup",
        condition: "Writing",
        model: "openai/gpt-5.6-luna",
        reasoning_effort: "low",
        enabled: true,
      },
    ],
  });

  const server = createServer("legacy-migration.sqlite");
  try {
    const settings = await getSettings(server.url);
    const profiles = settings.worker_profiles as Array<
      Record<string, unknown>
    >;

    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toEqual({
      id: "default",
      label: "Deep work",
      enabled: true,
      job: { kind: "custom", text: "Research and review" },
      model: "openai/gpt-5.6-sol",
      reasoning_effort: "high",
    });
    expect(profiles[1]).toEqual({
      id: "worker_profile_2",
      label: "Routine",
      enabled: true,
      job: { kind: "builtin", job: "coding" },
      model: settings.model,
      reasoning_effort: settings.reasoning_effort,
    });
    expect(profiles[2]).toEqual({
      id: "deep-work",
      label: "Dup",
      enabled: true,
      job: { kind: "custom", text: "Writing" },
      model: "openai/gpt-5.6-luna",
      reasoning_effort: "low",
    });

    const persisted = readPersistedSettings(dbPath);
    expect(Array.isArray(persisted.worker_profiles)).toBe(true);
    expect(persisted.worker_profiles).toEqual(profiles);
    expect(Object.keys(persisted)).not.toContain("worker_model_rules");

    const again = await getSettings(server.url);
    expect(again.worker_profiles).toEqual(profiles);
  } finally {
    server.stop();
  }
});

const LEGACY_WORKER_MODEL_RULES = [
  {
    id: "deep_work",
    label: "Deep work",
    condition: "Research  and   review",
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "high",
    enabled: false,
  },
];

test("persisted empty canonical worker_profiles ignore legacy rules and repair to the default profile", async () => {
  const dbName = "canonical-empty.sqlite";
  const dbPath = join(tempDir, dbName);
  const bootstrap = createServer(dbName);
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    language: "ko",
    worker_profiles: [],
    worker_model_rules: LEGACY_WORKER_MODEL_RULES,
  });

  const server = createServer(dbName);
  try {
    const settings = await getSettings(server.url);
    const profiles = settings.worker_profiles as Array<
      Record<string, unknown>
    >;

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toEqual({
      id: "default",
      label: "Default",
      enabled: true,
      job: { kind: "builtin", job: "coding" },
      model: settings.model,
      reasoning_effort: settings.reasoning_effort,
    });

    const persisted = readPersistedSettings(dbPath);
    expect(persisted.worker_profiles).toEqual(profiles);
    expect(persisted.max_simultaneous_workers).toBe(10);
    expect(persisted.language).toBe("ko");
    expect(Object.keys(persisted)).not.toContain("worker_model_rules");
  } finally {
    server.stop();
  }
});

test("persisted malformed canonical worker_profiles ignore legacy rules and repair to the default profile", async () => {
  const dbName = "canonical-malformed.sqlite";
  const dbPath = join(tempDir, dbName);
  const bootstrap = createServer(dbName);
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    language: "ko",
    worker_profiles: { not_a_profile_list: true },
    worker_model_rules: LEGACY_WORKER_MODEL_RULES,
  });

  const server = createServer(dbName);
  try {
    const settings = await getSettings(server.url);
    const profiles = settings.worker_profiles as Array<
      Record<string, unknown>
    >;

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toEqual({
      id: "default",
      label: "Default",
      enabled: true,
      job: { kind: "builtin", job: "coding" },
      model: settings.model,
      reasoning_effort: settings.reasoning_effort,
    });

    const persisted = readPersistedSettings(dbPath);
    expect(persisted.worker_profiles).toEqual(profiles);
    expect(persisted.max_simultaneous_workers).toBe(10);
    expect(persisted.language).toBe("ko");
    expect(Object.keys(persisted)).not.toContain("worker_model_rules");
  } finally {
    server.stop();
  }
});

test("repeat GET over canonical storage returns identical view without rewriting the persisted row", async () => {
  const dbName = "idempotent-get.sqlite";
  const dbPath = join(tempDir, dbName);
  const sentinelUpdatedAt = "2000-01-01T00:00:00.000Z";
  const server = createServer(dbName);
  try {
    const first = await getSettings(server.url);
    const before = readPersistedSettingsRow(dbPath);
    stampPersistedUpdatedAt(dbPath, sentinelUpdatedAt);

    const second = await getSettings(server.url);

    expect(second).toEqual(first);
    const after = readPersistedSettingsRow(dbPath);
    expect(after.updated_at).toBe(sentinelUpdatedAt);
    expect(after.value_json).toBe(before.value_json);
    expect(JSON.parse(after.value_json).worker_profiles).toEqual(
      first.worker_profiles,
    );
  } finally {
    server.stop();
  }
});

test("PATCH round-trips custom jobs, domains and prompts with canonical-only persistence", async () => {
  const server = createServer("round-trip.sqlite");
  const dbPath = join(tempDir, "round-trip.sqlite");
  try {
    const patched = await patchSettings(server.url, {
      max_simultaneous_workers: 7,
      worker_profiles: [
        defaultProfile("openai/gpt-5.6-luna", "medium"),
        {
          id: "writer",
          label: "Writer",
          enabled: true,
          job: { kind: "custom", text: "Draft release notes" },
          domain: "docs",
          model: "openai/gpt-5.6-sol",
          reasoning_effort: "high",
          prompt: "Keep it short.",
        },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.data?.max_simultaneous_workers).toBe(7);
    expect(patched.data?.worker_profiles).toEqual([
      defaultProfile("openai/gpt-5.6-luna", "medium"),
      {
        id: "writer",
        label: "Writer",
        enabled: true,
        job: { kind: "custom", text: "Draft release notes" },
        domain: "docs",
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        prompt: "Keep it short.",
      },
    ]);

    const fetched = await getSettings(server.url);
    expect(fetched.worker_profiles).toEqual(patched.data?.worker_profiles);
    expect(fetched.max_simultaneous_workers).toBe(7);

    const persisted = readPersistedSettings(dbPath);
    expect(persisted.worker_profiles).toEqual(patched.data?.worker_profiles);
    expect(JSON.stringify(persisted)).not.toContain("worker_model_rule");
  } finally {
    server.stop();
  }
});

test("PATCH omitting the default profile preserves the exact current default while replacing user profiles", async () => {
  const server = createServer("omit-default.sqlite");
  try {
    const seeded = await patchSettings(server.url, {
      worker_profiles: [
        defaultProfile("openai/gpt-5.6-luna", "high", { prompt: "v1" }),
      ],
    });
    expect(seeded.status).toBe(200);
    const currentDefault = (
      seeded.data?.worker_profiles as Array<Record<string, unknown>>
    )[0];

    const updated = await patchSettings(server.url, {
      worker_profiles: [
        {
          id: "researcher",
          label: "Researcher",
          enabled: true,
          job: { kind: "custom", text: "Deep research" },
          model: "openai/gpt-5.6-sol",
          reasoning_effort: "xhigh",
        },
      ],
    });
    expect(updated.status).toBe(200);

    const fetched = await getSettings(server.url);
    const profiles = fetched.worker_profiles as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual(currentDefault);
    expect(profiles[0]?.model).toBe("openai/gpt-5.6-luna");
    expect(profiles[0]?.reasoning_effort).toBe("high");
    expect(profiles[1]?.id).toBe("researcher");
  } finally {
    server.stop();
  }
});

test("invalid worker profile patches reject fail-closed through the settings request path", async () => {
  const server = createServer("reject-patches.sqlite");
  try {
    const validModel = "openai/gpt-5.6-luna";

    async function expectRejected(body: unknown): Promise<void> {
      const result = await patchSettings(server.url, body);
      expect(result.status).toBe(400);
      expect(result.error?.code).toBe("invalid_settings_request");
    }

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { enabled: false }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium"),
        defaultProfile(validModel, "medium", { prompt: "second default" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { id: "research-a" }),
        defaultProfile(validModel, "medium", { id: "research-a" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium"),
        defaultProfile(validModel, "medium", { id: "writer-x" }),
        defaultProfile(validModel, "medium", { id: "Writer-X" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium"),
        defaultProfile(validModel, "medium", { id: "research-a" }),
        defaultProfile(validModel, "medium", { id: "research-a" }),
      ],
    });

    const { model: _missingModel, ...profileWithoutModel } = defaultProfile(
      validModel,
      "medium",
    );
    await expectRejected({
      worker_profiles: [profileWithoutModel],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { model: "openai/gpt-99" }),
      ],
    });

    await expectRejected({
      worker_profiles: [defaultProfile("openai/gpt-5.5", "max")],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { job: "coding" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", {
          job: { kind: "builtin", job: "astro" },
        }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", {
          job: { kind: "builtin", job: "coding", priority: 1 },
        }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { tags: ["preferred"] }),
      ],
    });

    await expectRejected({ max_simultaneous_workers: 11 });
    await expectRejected({ max_simultaneous_workers: 0 });
    await expectRejected({ max_simultaneous_workers: 2.5 });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { label: "" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", { id: "Bad Id" }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", {
          prompt: "x".repeat(2001),
        }),
      ],
    });

    await expectRejected({
      worker_profiles: [
        defaultProfile(validModel, "medium", {
          domain: "d".repeat(97),
        }),
      ],
    });

    const excessive = Array.from({ length: 13 }, (_, index) =>
      defaultProfile(validModel, "medium", { id: `profile-${index + 1}` }),
    );
    await expectRejected({ worker_profiles: excessive });

    const fetched = await getSettings(server.url);
    const profiles = fetched.worker_profiles as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe("default");
    expect(fetched.max_simultaneous_workers).toBe(10);
  } finally {
    server.stop();
  }
});

function storedProfileFixture(
  id: unknown,
  label: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...(id === undefined ? {} : { id }),
    label,
    enabled: true,
    job: { kind: "builtin", job: "coding" },
    model: "openai/gpt-5.6-luna",
    reasoning_effort: "medium",
    ...overrides,
  };
}

function expectProtocolValidIds(profiles: Array<Record<string, unknown>>) {
  const ids = profiles.map((profile) => profile.id as string);
  for (const id of ids) {
    expect(WORKER_PROFILE_ID_PATTERN.test(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(48);
  }
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

async function expectCanonicalRoundTrip(dbName: string, dbPath: string) {
  const server = createServer(dbName);
  try {
    const settings = await getSettings(server.url);
    const profiles = settings.worker_profiles as Array<
      Record<string, unknown>
    >;
    const ids = expectProtocolValidIds(profiles);

    const persisted = readPersistedSettings(dbPath);
    expect(persisted.worker_profiles).toEqual(profiles);

    const again = await getSettings(server.url);
    expect(again.worker_profiles).toEqual(profiles);

    const patched = await patchSettings(server.url, {
      worker_profiles: profiles,
    });
    expect(patched.status).toBe(200);
    expect(patched.data?.worker_profiles).toEqual(profiles);
    expect(readPersistedSettings(dbPath).worker_profiles).toEqual(profiles);
    return { ids, profiles, server };
  } catch (error) {
    server.stop();
    throw error;
  }
}

test("persisted leading-invalid and empty worker profile ids are repaired deterministically without dropping or reordering profiles", async () => {
  const dbName = "repair-invalid-ids.sqlite";
  const dbPath = join(tempDir, dbName);
  const bootstrap = createServer(dbName);
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    worker_profiles: [
      storedProfileFixture("default", "Default"),
      storedProfileFixture("_bad", "Bad"),
      storedProfileFixture("__also_bad", "Also bad"),
      storedProfileFixture("", "Empty id"),
    ],
  });

  let result: Awaited<ReturnType<typeof expectCanonicalRoundTrip>> | undefined;
  try {
    result = await expectCanonicalRoundTrip(dbName, dbPath);
    expect(result.ids).toEqual([
      "default",
      "bad",
      "also_bad",
      "worker_profile_4",
    ]);
    expect(result.profiles.map((profile) => profile.label)).toEqual([
      "Default",
      "Bad",
      "Also bad",
      "Empty id",
    ]);
  } finally {
    result?.server.stop();
  }
});

test("duplicate 48-character persisted worker profile ids are deduplicated with suffix width reserved under the id limit", async () => {
  const dbName = "duplicate-max-length-ids.sqlite";
  const dbPath = join(tempDir, dbName);
  const bootstrap = createServer(dbName);
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  const baseId = "b".repeat(48);
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    worker_profiles: [
      storedProfileFixture("default", "Default"),
      storedProfileFixture(baseId, "One"),
      storedProfileFixture(baseId, "Two"),
    ],
  });

  let result: Awaited<ReturnType<typeof expectCanonicalRoundTrip>> | undefined;
  try {
    result = await expectCanonicalRoundTrip(dbName, dbPath);
    expect(result.ids[1]).toBe(baseId);
    expect(result.ids[2]).toBe(`${baseId.slice(0, 46)}-2`);
    expect(result.profiles.map((profile) => profile.label)).toEqual([
      "Default",
      "One",
      "Two",
    ]);
  } finally {
    result?.server.stop();
  }
});

test("repeated collisions across suffix widths keep every repaired worker profile id unique, ordered and within the limit", async () => {
  const dbName = "repeated-collision-widths.sqlite";
  const dbPath = join(tempDir, dbName);
  const bootstrap = createServer(dbName);
  try {
    await getSettings(bootstrap.url);
  } finally {
    bootstrap.stop();
  }
  const baseId = "c".repeat(48);
  writePersistedSettings(dbPath, {
    gateway_profile: "electron",
    worker_profiles: [
      storedProfileFixture("default", "Default"),
      ...Array.from({ length: 11 }, (_, index) =>
        storedProfileFixture(baseId, `Worker ${index + 2}`),
      ),
    ],
  });

  let result: Awaited<ReturnType<typeof expectCanonicalRoundTrip>> | undefined;
  try {
    result = await expectCanonicalRoundTrip(dbName, dbPath);
    const expectedIds = [
      "default",
      baseId,
      ...Array.from({ length: 10 }, (_, index) => {
        const suffix = index + 2;
        const suffixText = `-${suffix}`;
        return `${baseId.slice(0, 48 - suffixText.length)}${suffixText}`;
      }),
    ];
    expect(result.ids).toEqual(expectedIds);
    expect(result.profiles.map((profile) => profile.label)).toEqual([
      "Default",
      ...Array.from({ length: 11 }, (_, index) => `Worker ${index + 2}`),
    ]);

    const restarted = createServer(dbName);
    try {
      const again = await getSettings(restarted.url);
      expect(again.worker_profiles).toEqual(result.profiles);
    } finally {
      restarted.stop();
    }
  } finally {
    result?.server.stop();
  }
});
