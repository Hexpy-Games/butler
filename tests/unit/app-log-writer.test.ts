// test-category: security
import { expect, test, setSystemTime } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppLogWriter } from "../../packages/butler-app/client/electron/log/writer.mjs";
import { createRedactor } from "../../packages/butler-app/client/electron/log/redaction.mjs";

test("App redaction covers credentials, cookies, signed queries and registered bare secrets", () => {
  const redactor = createRedactor();
  redactor.remember("bare-local-credential"); redactor.remember("1234 5678");
  const result = JSON.stringify(redactor.redact({
    authorization: "Bearer private-auth", cookie: "arbitrary=private-cookie", nested: { api_key: "private-key" },
    quoted: '{"password":"first second"}',
    cookieText: `"Cookie":"sid=abc'def"`, path: "/Users/First Last/file", suffixKey: "mytoken=private-suffix",
    msg: "bare-local-credential connection_code=1234 5678 Bearer private-bearer Cookie: arbitrary=private-cookie",
    url: "https://user:pass@example.test/path?code=private-code&x-amz-signature=private-signature&safe=yes",
  }));
  for (const value of ["bare-local-credential", "1234 5678", "private-auth", "private-cookie", "private-key", "private-bearer", "private-code", "private-signature", "user:pass", "first", "second", "abc", "def", "First", "Last", "private-suffix"]) expect(result).not.toContain(value);
  expect(result).toContain("safe=yes");
});

test("App writer batches, rotates at 16 MB, preserves records and only admits configured levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-writer-"));
  const writer = createAppLogWriter(root);
  try {
    writer.record({ level: "DEBUG", category: "ipc", event: "hidden", msg: "hidden" });
    writer.configure({ effective: { level: "full", category_levels: {} } });
    const content = "a".repeat(250_000);
    for (let i = 0; i < 70; i++) writer.record({ level: "INFO", category: "lifecycle", event: "row", msg: String(i), attrs: { content, token: "private-value" } });
    await writer.flush();
    expect(writer.failure).toBeNull();
    const directory = join(root, "logs/app/main");
    const names = (await readdir(directory)).sort();
    expect(names.length).toBe(2);
    const rows = [];
    for (const name of names) {
      expect(name).toMatch(/^\d{8}T\d{6}Z-\d{4}-[a-f0-9-]{36}\.jsonl$/u);
      expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(16 * 1024 * 1024);
      const text = await readFile(join(directory, name), "utf8");
      expect(text).not.toContain("private-value");
      rows.push(...text.trim().split("\n").map(line => JSON.parse(line)));
    }
    expect(rows.map(row => row.msg)).toEqual(Array.from({ length: 70 }, (_, i) => String(i)));
    expect(rows.every(row => row.process === "app.main" && !Number.isNaN(Date.parse(row.ts)))).toBe(true);
    writer.configure({ effective: { level: "standard", category_levels: {} } });
    writer.record({ level: "TRACE", category: "ipc", event: "hidden", msg: "hidden" });
    await writer.flush();
    expect(await readdir(join(root, "logs/app"))).toEqual(["main"]);
  } finally { await writer.quit(); await rm(root, { recursive: true, force: true }); }
});


test("credentials load before the first queued write, including bare values", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-credentials-"));
  const auth = join(root, "app/runtime/auth");
  await mkdir(auth, { recursive: true });
  await writeFile(join(auth, "local-agent-auth.json"), JSON.stringify({ token: "local-bare-credential" }));
  await writeFile(join(auth, "local-admin.json"), JSON.stringify({ secret: "local-bare-admin-credential" }));
  const writer = createAppLogWriter(root);
  try {
    writer.record({ level: "ERROR", category: "lifecycle", event: "failure", msg: "local-bare-credential local-bare-admin-credential" });
    await writer.flush();
    expect(writer.failure).toBeNull();
    for (const name of await readdir(join(root, "logs/app/main"))) {
      const text = await readFile(join(root, "logs/app/main", name), "utf8");
      expect(text).not.toContain("local-bare-credential");
      expect(text).not.toContain("local-bare-admin-credential");
      expect(text).toContain("[REDACTED]");
    }
  } finally { await writer.quit(); await rm(root, { recursive: true, force: true }); }
});


test("secondary App roles never write to the UI owner's log directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-secondary-"));
  const writer = createAppLogWriter(root, () => false);
  try {
    writer.record({ level: "ERROR", category: "lifecycle", event: "failure", msg: "secondary" });
    await writer.quit();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("full payload recording expires locally while the agent is unavailable", async () => {
  const writer = createAppLogWriter(null);
  try {
    writer.configure({ effective: { level: "detailed", category_levels: {} } });
    writer.configure({ effective: { level: "full", category_levels: {} }, full_expires_at: new Date(Date.now() - 1).toISOString() });
    expect(writer.enabled("ipc", "TRACE")).toBe(false);
    expect(writer.enabled("ipc", "DEBUG")).toBe(true);
  } finally { await writer.quit(); }
});

test("full bodies are referenced, redacted and removed by their App owner on level drop and expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-bodies-"));
  const writer = createAppLogWriter(root);
  try {
    writer.configure({ effective: { level: "full", category_levels: {} } });
    writer.record({ level: "TRACE", category: "ipc", event: "ipc.payload", msg: "IPC payload recorded" }, "app.main", { draft: "private draft", token: "private-token" });
    await writer.flush();
    const debug = join(root, "logs/app/debug");
    const row = JSON.parse((await readFile(join(debug, (await readdir(debug))[0]), "utf8")).trim());
    expect(JSON.stringify(row)).not.toContain("private draft");
    const [name, offset, length] = row.body_ref.split(":");
    const { zstdDecompressSync } = await import("node:zlib");
    const bytes = await readFile(join(root, "logs/app/bodies", name));
    expect(JSON.parse(zstdDecompressSync(bytes.subarray(Number(offset), Number(offset) + Number(length))).toString())).toEqual({ draft: "private draft", token: "[REDACTED]" });
    writer.configure({ effective: { level: "detailed", category_levels: {} } });
    await writer.flush();
    expect(await readdir(join(root, "logs/app"))).toEqual(["debug"]);
    writer.configure({ effective: { level: "full", category_levels: {} }, full_expires_at: new Date(Date.now() + 100).toISOString() });
    writer.record({ level: "TRACE", category: "ipc", event: "ipc.payload", msg: "IPC payload recorded" }, "app.main", ["expiring draft"]);
    await writer.flush();
    await new Promise(resolve => setTimeout(resolve, 150));
    await writer.flush();
    expect(await readdir(join(root, "logs/app"))).toEqual(["debug"]);
    writer.configure({ effective: { level: "standard", category_levels: {} } });
    await writer.flush();
    expect(await readdir(join(root, "logs/app"))).toEqual([]);
  } finally { await writer.quit(); await rm(root, { recursive: true, force: true }); }
});

test("credential registration is explicit, bounded, length gated and permanent credentials remain", () => {
  const redactor = createRedactor();
  redactor.remember("book");
  redactor.remember("permanent-credential-value", true);
  redactor.remember("old-ephemeral-credential");
  for (let i = 0; i < 256; i++) redactor.remember(`temporary-credential-${i}`);
  expect(redactor.redact("book old-ephemeral-credential permanent-credential-value temporary-credential-255")).toBe("book old-ephemeral-credential [REDACTED] [REDACTED]");
});

test("the final redacted line must fit one MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-limit-"));
  const writer = createAppLogWriter(root);
  try {
    writer.record({ level: "INFO", category: "lifecycle", event: "large", msg: "sk-a ".repeat(100_000) });
    await writer.flush();
    expect(await readdir(root)).toEqual([]);
  } finally { await writer.quit(); await rm(root, { recursive: true, force: true }); }
});


test("expired body references never alias a later full lease in the same second", async () => {
  setSystemTime(new Date("2026-10-19T00:00:00Z"));
  const root = await mkdtemp(join(tmpdir(), "app-log-identity-"));
  let previous;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const writer = createAppLogWriter(root);
      try {
        writer.configure({ effective: { level: "full", category_levels: {} } });
        writer.record({ level: "TRACE", category: "ipc", event: "ipc.payload", msg: "IPC payload recorded" }, "app.main", ["same sized body"]);
        await writer.flush();
        const name = (await readdir(join(root, "logs/app/bodies")))[0];
        if (previous) expect(name).not.toBe(previous);
        previous = name;
        writer.configure({ effective: { level: "detailed", category_levels: {} } });
        await writer.flush();
      } finally { await writer.quit(); }
    }
  } finally { setSystemTime(); await rm(root, { recursive: true, force: true }); }
});

test("durable clear generations remove missed App logs once across reconnects and restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-log-clear-generation-"));
  let writer = createAppLogWriter(root);
  const view = { effective: { level: "full", category_levels: {} }, clear_generation: "generation-one" };
  const record = () => writer.record({ level: "TRACE", category: "ipc", event: "ipc.payload", msg: "IPC payload" }, "app.main", { input: "captured" });
  try {
    writer.configure({ effective: view.effective });
    record(); await writer.flush();
    const bodies = join(root, "logs/app/bodies");
    const previous = await readdir(bodies).catch(() => []);
    record(); // Still queued when the clear's config refresh flushes.
    writer.configure(view); await writer.flush();
    expect(await readdir(bodies).catch(() => [])).toEqual([]);
    record(); await writer.flush();
    const current = await readdir(bodies);
    expect(current.length).toBeGreaterThan(0);
    writer.configure(view); await writer.flush();
    expect(await readdir(bodies)).toEqual(current);
    await writer.quit();
    writer = createAppLogWriter(root);
    writer.configure(view); await writer.flush();
    expect(await readdir(bodies)).toEqual(current);
    await writeFile(join(root, "logs/clear-generation"), "generation-two");
    // The config route may be denied after diagnostics is disabled.
    writer.configure({ effective: { level: "standard", category_levels: {} } }); await writer.flush();
    expect(await readdir(bodies).catch(() => [])).toEqual([]);
    expect(previous.every(file => !current.includes(file))).toBe(true);
  } finally { await writer.quit(); await rm(root, { recursive: true, force: true }); }
});
