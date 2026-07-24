import { createHash } from "node:crypto";
import {
  assertLogicalLedgerRecordBytes,
  contentRef,
  createLogicalLedgerBundle,
  logicalLedgerRecords,
  planningCandidateBundleEntries,
  stableJson,
  type BtccPersistenceTypes,
  type WorkLedgerCommit,
} from "../../../btcc/index.ts";
import type { ProjectLedgerCore } from "./project-ledger-core.ts";

type Program = BtccPersistenceTypes["managedProgramState"];
type Ref = { id: string; sha256: string };
type Candidate = Extract<WorkLedgerCommit["mutation"], { kind: "install_reviewed_plan" }>["product"][
  "candidate"
];
type Bundle = Candidate["bundle"] & {
  entries: ReturnType<typeof planningCandidateBundleEntries>;
};

export function materializeProjectProgram(
  core: ProjectLedgerCore,
  root: string,
  program: Program,
  commit: WorkLedgerCommit,
): void {
  const previous = loadProjectProgram(core, root, program.programId);
  const logicalBundle = createLogicalLedgerBundle({ commit, previous, next: program });
  const planningBundle = commit.mutation.kind === "install_reviewed_plan"
    ? verifiedPlanningBundle(commit.mutation.product.candidate)
    : undefined;
  for (const entry of planningBundle?.entries ?? []) {
    ensureReference(core, root, entry.ref, entry.semanticBytes, `BTCC ${entry.recordKind}`);
  }
  if (commit.mutation.kind === "install_reviewed_plan") {
    for (const spec of commit.mutation.product.candidate.authoredSpecs) {
      const identity = program.availableSpecs.find((item) => item.revisionRef.id === spec.ref.id);
      if (!identity) throw new Error("Authored Spec has no canonical revision identity");
      ensureModeledRecord(core, root, "spec", identity.logicalId, spec.title,
        spec.body.normalize("NFC"), "specified", {
          revisionRef: identity.revisionRef.id,
          logicalId: spec.logicalId,
          parentId: spec.parentId,
          concernId: spec.concernId,
        });
    }
  }
  for (const record of logicalLedgerRecords(commit.mutation, previous)) {
    ensureReference(core, root, record.ref, record.semanticBytes,
      `BTCC logical Ledger record ${record.sourceRef.id}`);
  }
  if (program.planningState === "reviewed") materializeGraph(core, root, program, planningBundle);
  const { ref: _bundleRef, ...logicalBundleBody } = logicalBundle;
  ensureReference(core, root, logicalBundle.ref, stableJson(logicalBundleBody),
    `BTCC logical Ledger bundle ${commit.mutation.kind}`);
  writeManifest(core, root, program);
}

export function loadProjectProgram(
  core: ProjectLedgerCore,
  root: string,
  programId: string,
): Program | null {
  try {
    const record = core.resolveRecord(root, { kind: "reference", id: manifestId(programId) });
    const body = core.readRecordBody(record.filePath);
    if (!body) throw new Error("Project Work Ledger manifest body is missing");
    const program = JSON.parse(body) as Program;
    if (program.programId !== programId) throw new Error("Project Work Ledger manifest identity changed");
    return program;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function materializeGraph(
  core: ProjectLedgerCore,
  root: string,
  program: Extract<Program, { planningState: "reviewed" }>,
  bundle?: Bundle,
): void {
  ensureModeledRecord(core, root, "plan", program.plan.ref.id,
    `BTCC reviewed plan for ${program.programId}`,
    exactSemanticBytes(program.plan, bundle), "active");
  for (const work of program.works) {
    ensureModeledRecord(core, root, "work", work.work.ref.id, work.work.outcome,
      exactSemanticBytes(work.work, bundle), projectWorkStatus(work.status), {
        spec: requiredSpec(program).id,
        acceptance: work.work.outcome,
        validation: program.planningReviewRef.id,
        review: program.planningReviewRef.id,
        report: work.status === "closed" ? program.planningReviewRef.id : undefined,
      });
  }
  const workRefs = new Map(program.works.map((work) => [work.work.workLogicalId, work.work.ref.id]));
  for (const task of program.tasks) {
    const workId = workRefs.get(task.task.workLogicalId);
    if (!workId) throw new Error("Project Work Ledger Task has no active Work");
    ensureModeledRecord(core, root, "task", task.task.ref.id, task.task.intendedOutcome,
      exactSemanticBytes(task.task, bundle), projectTaskStatus(task.status), {
        work: workId,
        validation: program.planningReviewRef.id,
        review: task.currentReview?.review.ref.id ?? program.planningReviewRef.id,
        report: task.status === "accepted" ? task.currentReview?.review.ref.id : undefined,
      });
  }
}

function exactSemanticBytes(value: { ref: Ref } & Record<string, unknown>, bundle?: Bundle): string {
  const prepared = bundle?.entries.find((entry) => entry.ref.id === value.ref.id);
  if (!prepared) return semanticBody(value);
  if (prepared.ref.sha256 !== value.ref.sha256) {
    throw new Error("Prepared Planning bundle ref changed after review");
  }
  return prepared.semanticBytes;
}

function verifiedPlanningBundle(candidate: Candidate): Bundle {
  const bundle = candidate.bundle;
  const { ref, ...body } = bundle;
  const expected = contentRef("planning-candidate-bundle", body);
  if (expected.id !== ref.id || expected.sha256 !== ref.sha256) {
    throw new Error("Accepted Planning bundle identity changed after review");
  }
  const entries = planningCandidateBundleEntries(candidate);
  for (const entry of entries) {
    if (stableJson(JSON.parse(entry.semanticBytes)) !== entry.semanticBytes ||
      digest(entry.semanticBytes) !== entry.ref.sha256) {
      throw new Error(`Accepted Planning bundle entry changed: ${entry.ref.id}`);
    }
  }
  if (stableJson(entries.map((entry) => entry.ref)) !== stableJson(bundle.recordRefs)) {
    throw new Error("Accepted Planning bundle record index changed");
  }
  return { ...bundle, entries };
}

function ensureModeledRecord(
  core: ProjectLedgerCore,
  root: string,
  kind: "spec" | "plan" | "work" | "task",
  id: string,
  title: string,
  body: string,
  status: string,
  metadata: Record<string, unknown> = {},
): void {
  try {
    const current = core.resolveRecord(root, { kind, id }).record as { status: string };
    const statuses = statusRoute(kind, current.status, status);
    for (const nextStatus of statuses) {
      const options = { project: root, kind, id, title, status: nextStatus, body, ...defined(metadata) };
      if (kind === "work") core.updateWork(root, options);
      else if (kind === "task") core.updateTask(root, options);
      else core.updateRecord(root, options);
    }
    if (statuses.length === 0) {
      core.updateRecord(root, { project: root, kind, id, title, body, ...defined(metadata) });
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const options = { project: root, id, title, status, body, ...defined(metadata) };
  if (kind === "work") core.createWork(root, options);
  else if (kind === "task") core.createTask(root, options);
  else core.createRecord(root, { ...options, kind });
}

function writeManifest(core: ProjectLedgerCore, root: string, program: Program): void {
  const id = manifestId(program.programId);
  const body = stableJson(program);
  try {
    core.resolveRecord(root, { kind: "reference", id });
    core.updateRecord(root, { project: root, kind: "reference", id, status: "active", body });
  } catch (error) {
    if (!isMissing(error)) throw error;
    core.createRecord(root, {
      project: root,
      kind: "reference",
      id,
      title: `BTCC active manifest ${program.programId}`,
      status: "active",
      body,
    });
  }
}

function ensureReference(
  core: ProjectLedgerCore,
  root: string,
  ref: Ref,
  body: string,
  title: string,
): void {
  if (ref.id.startsWith("ledger-record:")) assertLogicalLedgerRecordBytes(ref, body);
  try {
    const found = core.resolveRecord(root, { kind: "reference", id: ref.id });
    if (core.readRecordBody(found.filePath) !== body) {
      throw new Error(`Project Work Ledger immutable record changed: ${ref.id}`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  core.createRecord(root, { project: root, kind: "reference", id: ref.id, title, status: "active", body });
}

function semanticBody(value: { ref: Ref } & Record<string, unknown>): string {
  const { ref, ...semantic } = value;
  const body = stableJson(semantic);
  if (digest(body) !== ref.sha256) throw new Error(`Project Work Ledger semantic record changed: ${ref.id}`);
  return body;
}

function projectWorkStatus(status: "planned" | "active" | "closed"): string {
  return status === "planned" ? "specified" : status === "active" ? "in_progress" : "done";
}

function projectTaskStatus(status: Extract<Program, { planningState: "reviewed" }>["tasks"][number]["status"]): string {
  if (status === "planned") return "todo";
  if (status === "accepted") return "done";
  if (status === "review_failed") return "failed";
  if (status === "promotion_deferred") return "blocked";
  return "in_progress";
}

function statusRoute(kind: "spec" | "plan" | "work" | "task", current: string, target: string): string[] {
  if (current === target) return [];
  if (kind === "plan" || kind === "spec") return [target];
  if (current === "done" || current === "cancelled") return [];
  if (kind === "work") {
    if (target === "specified") return current === "proposed" ? ["scoped", "specified"] : [];
    if (target === "in_progress") return ["in_progress"];
    if (target === "done") {
      return current === "review" ? ["done"] : current === "in_progress"
        ? ["review", "done"] : ["in_progress", "review", "done"];
    }
    return [target];
  }
  if (target === "todo") return current === "failed" || current === "blocked" ? ["in_progress"] : [];
  if (target === "in_progress") return ["in_progress"];
  if (target === "done") return current === "todo" ? ["in_progress", "done"] : ["done"];
  return current === "todo" && target === "failed" ? ["in_progress", "failed"] : [target];
}

function manifestId(programId: string): string {
  return `BTCC-PROGRAM-${programId}`;
}

function requiredSpec(program: Program): Ref {
  const spec = program.governingSpecRefs[0];
  if (!spec) throw new Error("Project Work Ledger Program has no governing Spec revision");
  const identity = program.availableSpecs.find((candidate) => candidate.revisionRef.id === spec.id);
  if (!identity) throw new Error("Governing Spec revision has no canonical logical identity");
  return { id: identity.logicalId, sha256: spec.sha256 };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "record_not_found";
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
