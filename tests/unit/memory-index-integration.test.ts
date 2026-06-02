import { afterEach, beforeEach, expect, test } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createServer, type Server } from "net";
import { Database } from "bun:sqlite";

let tempDir = "";
let socketPath = "";
let server: Server | null = null;
const root = process.cwd();

beforeEach(async () => {
  tempDir = join("/tmp", `bmi-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
  mkdirSync(tempDir, { recursive: true });
  socketPath = join(tempDir, "e.sock");
  server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      let request: { text?: string; texts?: string[] };
      try {
        request = JSON.parse(data.trim());
      } catch {
        return;
      }
      if (Array.isArray(request.texts)) {
        socket.end(`${JSON.stringify({ embeddings: request.texts.map(vectorForText) })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ embedding: vectorForText(request.text ?? "") })}\n`);
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  server = null;
  if (existsSync(socketPath)) unlinkSync(socketPath);
  rmSync(tempDir, { recursive: true, force: true });
});

function vectorForText(text: string): number[] {
  const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Array.from({ length: 8 }, (_, index) => ((seed + index * 17) % 101) / 100);
}

async function runIndexCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const bunExecutable = process.env.BUTLER_BUN ?? "bun";
  const proc = Bun.spawn([bunExecutable, ...args], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_HOME: root,
      BUTLER_DATA: tempDir,
      EMBED_SOCKET: socketPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 15000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("strict index writes LanceDB rows and graph counts for normalized transcript chunks", async () => {
  const inputPath = join(tempDir, "input.jsonl");
  writeFileSync(inputPath, [
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-26T10:00:00.000Z",
      message: { role: "user", content: "버틀러 검색 공급자는 DuckDuckGo로 결정했습니다." },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-26T10:00:10.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "프로젝트 결정으로 기록하겠습니다." }],
      },
    }),
  ].join("\n"), "utf8");

  const result = await runIndexCli([
    "run",
    "packages/butler-agent/src/agent/cognition/memory/scripts/index.ts",
    "--file",
    inputPath,
    "--project",
    "butler",
    "--session-id",
    "butler_main_c0",
    "--source-session-id",
    "butler/main",
    "--strict",
  ]);

  if (result.exitCode !== 0) {
    throw new Error([
      `index.ts exited with status=${result.exitCode}`,
      result.stdout ? `stdout=${result.stdout}` : "",
      result.stderr ? `stderr=${result.stderr}` : "",
    ].filter(Boolean).join("\n"));
  }
  const db = await lancedb.connect(join(tempDir, "cognition", "memory", "db", "butler.lance"));
  const table = await db.openTable("butler_memory");
  expect(await table.countRows()).toBeGreaterThan(0);

  const graph = new Database(join(tempDir, "cognition", "memory", "db", "graph.sqlite"), { readonly: true });
  try {
    expect((graph.prepare("SELECT COUNT(*) AS count FROM entities").get() as { count: number }).count).toBeGreaterThan(0);
    expect((graph.prepare("SELECT COUNT(*) AS count FROM entity_mentions").get() as { count: number }).count).toBeGreaterThan(0);
  } finally {
    graph.close();
  }
}, 70000);

test("plain-text index writes hot-cache summary rows into LanceDB", async () => {
  const inputPath = join(tempDir, "hot-summary.md");
  writeFileSync(
    inputPath,
    [
      "## [12:00] butler | hot-session",
      "**Task**: Butler web reader uses Readability with fallback raw mode.",
      "**Learning**: Article, product, and list pages need separate extraction modes.",
    ].join("\n"),
    "utf8",
  );

  const result = await runIndexCli([
    "run",
    "packages/butler-agent/src/agent/cognition/memory/scripts/index.ts",
    "--file",
    inputPath,
    "--project",
    "butler",
    "--session-id",
    "hot_butler_main_c0",
    "--source-session-id",
    "butler/main",
    "--type",
    "hot-cache",
    "--source",
    "hot-cache",
    "--plain-text",
    "--strict",
  ]);

  if (result.exitCode !== 0) {
    throw new Error([
      `index.ts exited with status=${result.exitCode}`,
      result.stdout ? `stdout=${result.stdout}` : "",
      result.stderr ? `stderr=${result.stderr}` : "",
    ].filter(Boolean).join("\n"));
  }
  const db = await lancedb.connect(join(tempDir, "cognition", "memory", "db", "butler.lance"));
  const table = await db.openTable("butler_memory");
  const rows = await table.query().where("source = 'hot-cache'").limit(10).toArray() as Array<{
    text?: string;
    type?: string;
    source?: string;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("hot-cache");
  expect(rows[0]?.source).toBe("hot-cache");
  expect(rows[0]?.text).toContain("Readability");
}, 70000);
