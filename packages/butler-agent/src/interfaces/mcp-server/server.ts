import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTaskResult, listTasks } from "./dispatcher.js";
import { listProjects } from "./projects.js";
import {
  getModelDetails,
  setModel,
  getButlerModelDetails,
  setButlerModel,
  VALID_MODELS,
  ALL_MODELS,
} from "./model.js";
import { startWatcher } from "./lifecycle.js";
import { loadSkills, getSkills } from "./skills.js";
import { config } from "./config.js";
import { BUTLER_DIR } from "./constants.ts";
import { getModelProviderControlStatus, renderModelProviderControlStatus } from "../../integrations/providers/control-plane.ts";
import {
  formatUptime,
  getNativeMainStatePath,
  isPidRunning,
  readNativeMainState,
  uptimeSecondsFromState,
} from "../../integrations/providers/native-main-state.ts";

// ── MCP server log (file only — stdout is reserved for JSON-RPC) ──────────────
const MCP_LOG_DIR = join(BUTLER_DIR.DATA, "logs");
const MCP_LOG = join(MCP_LOG_DIR, "mcp-server.log");
mkdirSync(MCP_LOG_DIR, { recursive: true });

function mcpLog(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  try {
    appendFileSync(MCP_LOG, `[${ts}] ${msg}\n`);
  } catch {}
}

process.on("uncaughtException", (err) => {
  mcpLog(`CRASH uncaughtException: ${err?.stack ?? err}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  mcpLog(`WARNING unhandledRejection: ${reason}`);
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"] as const) {
  process.on(sig, () => {
    mcpLog(`SHUTDOWN signal=${sig} pid=${process.pid}`);
    process.exit(0);
  });
}

process.on("exit", (code) => {
  mcpLog(`EXIT pid=${process.pid} code=${code}`);
});

mcpLog(`MCP server starting (pid=${process.pid}, version=1.0.0, ppid=${process.ppid})`);

const server = new McpServer({
  name: config.system.mcpServerName,
  version: "1.0.0",
});

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  "get_task_result",
  "Get the full result of a completed task.",
  {
    task_id: z.string().describe("Task ID returned by dispatch_task"),
  },
  async ({ task_id }) => {
    const info = await getTaskResult(task_id);
    const lines = [
      `Task: ${info.taskId}`,
      `Status: ${info.status}`,
      `Project: ${info.project}`,
      `Request: ${info.request}`,
      info.result ? `\nResult:\n${info.result}` : "",
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

server.tool(
  "list_tasks",
  "List all tasks, optionally filtered by status (RUNNING, DONE, FAILED, PENDING).",
  {
    status: z.string().optional().describe("Filter by status"),
  },
  async ({ status }) => {
    const tasks = await listTasks(status);
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No tasks found." }] };
    }
    const lines = tasks.map(
      (t) => `${t.taskId}  ${t.status.padEnd(8)}  ${t.project.padEnd(15)}  ${t.request.slice(0, 60)}`,
    );
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

server.tool(
  "butler_status",
  "Get butler system status: uptime, task stats, memory info.",
  {},
  async () => {
    // Uptime comes from the native main pid/state file.
    let uptime = "unknown";
    try {
      const state = readNativeMainState(getNativeMainStatePath(BUTLER_DIR.DATA));
      if (state && isPidRunning(state.pid)) {
        uptime = formatUptime(uptimeSecondsFromState(state));
      }
    } catch {}

    // Task stats
    const tasksDir = BUTLER_DIR.TASKS;
    let total = 0, running = 0, done = 0, failed = 0;
    try {
      const entries = readdirSync(tasksDir);
      total = entries.length;
      for (const e of entries) {
        try {
          const status = readFileSync(join(tasksDir, e, "status"), "utf8").trim();
          if (status === "RUNNING") running++;
          else if (status === "DONE") done++;
          else if (status === "FAILED") failed++;
        } catch {}
      }
    } catch {}

    // Hot cache stats
    const hotDir = join(BUTLER_DIR.MEMORY, "hot");
    let hotFiles = 0;
    try { hotFiles = readdirSync(hotDir).filter(f => f.endsWith(".md")).length; } catch {}

    const contextInfo = "native-local session state";

    const control = renderModelProviderControlStatus(getModelProviderControlStatus({
      sinceTs: Date.now() - 24 * 60 * 60 * 1000,
    }));

    const lines = [
      `Uptime: ${uptime}`,
      control,
      `Tasks: ${total} total (${running} running, ${done} done, ${failed} failed)`,
      `Context: ${contextInfo}`,
      `Hot cache: ${hotFiles} files`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "restart_butler",
  "Restart the butler. Use after code changes to mcp-server or watcher.",
  {},
  async () => {
    const { execFile } = await import("child_process");
    const scriptPath = join(BUTLER_DIR.SCRIPTS, "restart-butler.sh");
    // Use nohup + background so the restart script survives the MCP server being killed
    execFile("bash", ["-c", `nohup bash "${scriptPath}" > /dev/null 2>&1 &`], (err) => {
      if (err) console.error("restart error:", err);
    });
    return { content: [{ type: "text", text: "Butler restart initiated. Session will reconnect shortly." }] };
  },
);

server.tool(
  "project_list",
  "List all projects with recent task summaries. Use when user sends '/project'.",
  {},
  async () => {
    const projects = await listProjects();
    if (projects.length === 0) {
      return { content: [{ type: "text", text: "No project tasks found." }] };
    }

    const lines: string[] = [];
    for (const p of projects) {
      const statusParts = [];
      if (p.runningTasks > 0) statusParts.push(`${p.runningTasks} running`);
      statusParts.push(`${p.doneTasks} done`);
      if (p.failedTasks > 0) statusParts.push(`${p.failedTasks} failed`);

      lines.push(`📂 ${p.project} — ${p.totalTasks} tasks (${statusParts.join(", ")})`);
      for (const t of p.recentTasks) {
        const icon = t.status === "DONE" ? "✅" : t.status === "FAILED" ? "❌" : t.status === "RUNNING" ? "⏳" : "⏸️";
        lines.push(`  ${icon} ${t.request.slice(0, 80)}`);
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n").trim() }] };
  },
);

server.tool(
  "model_set",
  `Set or get the worker/butler model. Valid: ${VALID_MODELS.join(", ")}. Use target to specify worker or butler.`,
  {
    target: z.enum(["worker", "butler"]).optional().describe("Which model to set: worker (dispatch_task) or butler (main session). Omit to show both."),
    model: z.string().optional().describe("Model alias to set. Omit to get current model(s)."),
    action: z.enum(["list"]).optional().describe("Set to 'list' to show all available models."),
  },
  async ({ target, model, action }) => {
    // action=list → show all available models
    if (action === "list") {
      const lines = [
        "Available models:",
        "",
        "Aliases:",
        ...VALID_MODELS.map(m => `  ${m}`),
        "",
        "Legacy (full IDs):",
        ...ALL_MODELS.slice(VALID_MODELS.length).map(m => `  ${m}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // No target, no model → show both current models
    if (!target && !model) {
      const worker = getModelDetails();
      const butler = getButlerModelDetails();
      return {
        content: [{
          type: "text",
          text:
            `Worker model: ${worker.raw}\n` +
            `  provider: ${worker.providerId}\n` +
            `  model: ${worker.modelId}\n` +
            `  canonical: ${worker.canonicalRef}\n` +
            `Butler model: ${butler.raw}\n` +
            `  provider: ${butler.providerId}\n` +
            `  model: ${butler.modelId}\n` +
            `  canonical: ${butler.canonicalRef}`,
        }],
      };
    }

    // Set model
    if (model) {
      const t = target || "worker";
      try {
        if (t === "butler") {
          setButlerModel(model);
          return { content: [{ type: "text", text: `Butler model changed to: ${model} (applies at next restart)` }] };
        } else {
          setModel(model);
          return { content: [{ type: "text", text: `Worker model changed to: ${model}` }] };
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }] };
      }
    }

    // Target specified but no model → show that target's current model
    if (target === "butler") {
      const butler = getButlerModelDetails();
      return {
        content: [{
          type: "text",
          text:
            `Butler model: ${butler.raw}\n` +
            `provider: ${butler.providerId}\n` +
            `model: ${butler.modelId}\n` +
            `canonical: ${butler.canonicalRef}`,
        }],
      };
    }
    const worker = getModelDetails();
    return {
      content: [{
        type: "text",
        text:
          `Worker model: ${worker.raw}\n` +
          `provider: ${worker.providerId}\n` +
          `model: ${worker.modelId}\n` +
          `canonical: ${worker.canonicalRef}`,
      }],
    };
  },
);

server.tool(
  "memory_graph",
  "Query the entity relationship graph. Find connections between projects, decisions, tools, and people.",
  {
    query: z.string().describe("Entity name or keyword to search"),
    type: z.enum(["project", "person", "concept", "decision", "tool", "interest"]).optional().describe("Filter by entity type"),
    hops: z.number().int().min(1).max(4).optional().describe("How many relationship hops to traverse (default: 2)"),
    project: z.string().optional().describe("Filter results to a specific project (e.g. 'butler')"),
  },
  async ({ query, type, hops = 2, project }) => {
    try {
      const { findEntities, getRelated } = await import("../../agent/cognition/memory/scripts/graph.ts");
      const matches = findEntities(query, type, project);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ entities: [], relationships: [] }) }] };
      }

      const entityMap = new Map<string, any>();
      const edges: Array<{ from: string; to: string; hops: number }> = [];

      for (const entity of matches.slice(0, 5)) {
        entityMap.set(entity.id, { ...entity, properties: JSON.parse(entity.properties || "{}") });
        const related = getRelated(entity.id, hops);
        for (const r of related) {
          if (project && r.project !== project) continue;
          if (!entityMap.has(r.id)) {
            entityMap.set(r.id, { ...r, properties: JSON.parse(r.properties || "{}") });
          }
          edges.push({ from: entity.id, to: r.id, hops: r.hops });
        }
      }

      const result = {
        entities: [...entityMap.values()],
        relationships: edges,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Graph unavailable: ${err.message}` }] };
    }
  },
);

server.tool(
  "skill_list",
  "List all loaded skills with applicability notes and descriptions. Use when user sends '/skills'.",
  {},
  async () => {
    const skills = getSkills();
    if (skills.length === 0) {
      return { content: [{ type: "text", text: "No skills loaded." }] };
    }

    const lines = skills.map((s) => {
      const model = s.model ? ` [${s.model}]` : "";
      const invocable = s.userInvocable ? "" : " (internal)";
      return `• **${s.name}**${model}${invocable} — ${s.description}\n  applicability: ${s.applicability}\n  source: ${s.source}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  },
);

// ── Watcher (startup cleanup + singleton lock) ──────────────────────────────

startWatcher(server, (_event) => {
  // onEvent callback kept for future use (e.g. logging)
});

// ── Start ─────────────────────────────────────────────────────────────────────

await loadSkills();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Butler MCP server running (butler-main)");
