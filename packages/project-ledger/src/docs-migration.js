import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { LEDGER_DIR } from "./constants.js";
import {
  appendLedgerEvent,
  ensureDir,
  ledgerRoot,
  listFiles,
  projectPath,
  projectRelative,
} from "./fs.js";
import { markdownWithFrontmatter, parseFrontmatter, frontmatterBody } from "./frontmatter.js";
import { readRecordData } from "./records.js";

const TOP_LEVEL_REFERENCES = new Set([
  "architecture.md",
  "cli-reference.md",
  "memory-architecture.md",
  "project-structure.md",
  "release-checklist.md",
  "roles.md",
  "transport-adapter-template.md",
]);

function stripExtension(name) {
  return name.replace(/\.md$/u, "");
}

function slug(input) {
  return stripExtension(input)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

function titleFromPath(relPath) {
  return stripExtension(basename(relPath))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function titleFromMarkdown(text, relPath) {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || titleFromPath(relPath);
}

function statusFor(kind, text) {
  const status = text.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
  if (status) return status;
  if (kind === "report") return "done";
  if (kind === "decision") return "accepted";
  return "active";
}

function idFor(kind, targetRel) {
  const name = stripExtension(basename(targetRel));
  if (kind === "decision") {
    const number = name.match(/^(\d+)/u)?.[1];
    return number ? `ADR-${number}` : `DECISION-${slug(name)}`;
  }
  const prefix = {
    spec: "SPEC",
    report: "REPORT",
    plan: "PLAN",
    handoff: "HANDOFF",
    reference: "REF",
    roadmap: "ROADMAP",
  }[kind] ?? "DOC";
  return `${prefix}-${slug(targetRel.replace(new RegExp(`^${LEDGER_DIR}/[^/]+/`, "u"), ""))}`;
}

function classify(relPath) {
  if (!relPath.startsWith("docs/") || !relPath.endsWith(".md")) return null;
  const underDocs = relPath.slice("docs/".length);
  if (underDocs.startsWith("specs/")) {
    return { kind: "spec", targetRel: `${LEDGER_DIR}/specs/${underDocs.slice("specs/".length)}` };
  }
  if (underDocs.startsWith("reports/")) {
    return { kind: "report", targetRel: `${LEDGER_DIR}/reports/${underDocs.slice("reports/".length)}` };
  }
  if (underDocs.startsWith("decisions/")) {
    return { kind: "decision", targetRel: `${LEDGER_DIR}/decisions/${underDocs.slice("decisions/".length)}` };
  }
  if (underDocs.startsWith("handoffs/")) {
    return { kind: "handoff", targetRel: `${LEDGER_DIR}/handoffs/${underDocs.slice("handoffs/".length)}` };
  }
  if (basename(underDocs).startsWith("plan-")) {
    return { kind: "plan", targetRel: `${LEDGER_DIR}/plans/${underDocs}` };
  }
  if (basename(underDocs).startsWith("roadmap")) {
    return { kind: "roadmap", targetRel: `${LEDGER_DIR}/roadmaps/${underDocs}` };
  }
  if (underDocs === "agent-loop-completion-report.md") {
    return { kind: "report", targetRel: `${LEDGER_DIR}/reports/${underDocs}` };
  }
  if (TOP_LEVEL_REFERENCES.has(underDocs)) {
    return { kind: "reference", targetRel: `${LEDGER_DIR}/references/${underDocs}` };
  }
  return null;
}

function isCurrentSymlink(sourcePath, targetPath) {
  if (!existsSync(sourcePath)) return false;
  const stats = lstatSync(sourcePath);
  if (!stats.isSymbolicLink()) return false;
  const current = readlinkSync(sourcePath);
  return join(dirname(sourcePath), current) === targetPath;
}

function addLedgerFrontmatter(text, relPath, kind, targetRel) {
  const parsed = parseFrontmatter(text);
  const body = parsed ? frontmatterBody(text) : text;
  return markdownWithFrontmatter({
    schema: `project-ledger.${kind}.v1`,
    kind,
    id: parsed?.id ?? idFor(kind, targetRel),
    title: parsed?.title ?? titleFromMarkdown(body, relPath),
    status: parsed?.status ?? statusFor(kind, body),
    migratedFrom: relPath,
    updatedAt: parsed?.updatedAt ?? new Date().toISOString(),
    ...parsed,
  }, body);
}

function removeLegacyReferenceRecords(project, sourceRel, targetRel) {
  for (const file of listFiles(ledgerRoot(project), { skipDirs: new Set(["index", "views"]) })) {
    const rel = projectRelative(project, file);
    if (rel === targetRel || !file.endsWith(".md")) continue;
    const data = readRecordData(file);
    if (data?.implementation === sourceRel) {
      rmSync(file, { force: true });
    }
  }
}

export function planDocsMigration(project) {
  const docsRoot = join(project, "docs");
  const moves = [];
  const unsupported = [];
  for (const file of listFiles(docsRoot)) {
    if (!file.endsWith(".md")) continue;
    const sourceRel = projectRelative(project, file);
    const classified = classify(sourceRel);
    if (!classified) {
      unsupported.push({ path: sourceRel, reason: "unsupported_docs_shape" });
      continue;
    }
    moves.push({
      source: sourceRel,
      target: classified.targetRel,
      kind: classified.kind,
      compatibility: "symlink",
    });
  }
  return { moves, unsupported };
}

export function migrateDocs(project, options = {}) {
  const plan = planDocsMigration(project);
  if (!options.write) {
    return { ...plan, written: false };
  }

  for (const item of plan.moves) {
    const sourcePath = join(project, item.source);
    const targetPath = projectPath(project, item.target);
    if (isCurrentSymlink(sourcePath, targetPath)) continue;

    const text = readFileSync(sourcePath, "utf8");
    ensureDir(dirname(targetPath));
    writeFileSync(targetPath, addLedgerFrontmatter(text, item.source, item.kind, item.target), "utf8");
    removeLegacyReferenceRecords(project, item.source, item.target);

    rmSync(sourcePath, { force: true });
    ensureDir(dirname(sourcePath));
    symlinkSync(relative(dirname(sourcePath), targetPath), sourcePath);
  }

  appendLedgerEvent(project, {
    type: "docs_migrated",
    moved: plan.moves.length,
    unsupported: plan.unsupported.length,
    source: "project-ledger",
  });

  return { ...plan, written: true };
}
