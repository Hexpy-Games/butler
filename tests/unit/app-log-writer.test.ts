// test-category: security
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppLogWriter } from "../../packages/butler-app/client/electron/log/writer.mjs";
import { createRedactor } from "../../packages/butler-app/client/electron/log/redaction.mjs";

test("App redaction covers credentials, cookies, signed queries and registered bare secrets", () => {
  const redactor = createRedactor();
  redactor.remember("bare-local-credential"); redactor.observe({ connection_code: "1234 5678" });
  const result = JSON.stringify(redactor.redact({
    authorization: "Bearer private-auth", cookie: "arbitrary=private-cookie", nested: { api_key: "private-key" },
    quoted: '{"password":"first second"}',
    cookieText: `"Cookie":"sid=abc'def"`, path: "/Users/First Last/file", suffixKey: "mytoken=private-suffix",
    msg: "bare-local-credential 1234 5678 Bearer private-bearer Cookie: arbitrary=private-cookie",
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
      expect(name).toMatch(/^\d{8}T\d{6}Z-\d{4}\.jsonl$/u);
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
  const writer = createAppLogWriter(root);
  try {
    writer.record({ level: "ERROR", category: "lifecycle", event: "failure", msg: "local-bare-credential" });
    await writer.flush();
    expect(writer.failure).toBeNull();
    for (const name of await readdir(join(root, "logs/app/main"))) {
      const text = await readFile(join(root, "logs/app/main", name), "utf8");
      expect(text).not.toContain("local-bare-credential");
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
