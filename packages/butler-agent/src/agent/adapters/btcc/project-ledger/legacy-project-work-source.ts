import {
  contentRef,
  digest,
  stableJson,
} from "../../../btcc/identity/index.ts";
import type {
  LegacyProjectWorkSnapshot,
  LegacyProjectWorkSource,
} from "../../../btcc/work/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { decodeProjectLedgerBinding } from "./project-binding.ts";
import { loadProjectLedgerCore, type ProjectLedgerCore } from
  "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";

const STABLE_READ_ATTEMPTS = 2;
const LOGICAL_RECORD_PREFIX = "ledger-record:";

type Ref = { id: string; sha256: string };
type LegacyProjectProgram = {
  programId: string;
  manifestRevision: number;
  planningState: string;
  frontier: string;
  goalContractRef: Ref;
  plan?: unknown;
  works: Array<{ status: string; work: { ref: Ref } & Record<string, unknown> }>;
  tasks: Array<{ status: string; task: { ref: Ref } & Record<string, unknown> }>;
  criteria: Array<{ ref: Ref } & Record<string, unknown>>;
};
type ProjectLedgerHead = Awaited<ReturnType<typeof observeProjectLedgerHead>>;

export type LegacyProjectWorkReader = {
  observeCanonicalHead(projectRoot: string): Promise<ProjectLedgerHead>;
  loadProgram(
    projectRoot: string,
    programId: string,
  ): Promise<LegacyProjectProgram | null>;
};

export function createProjectLedgerLegacyWorkSource(input: {
  butlerData: string;
  resolver?: ActiveProjectLedgerResolver;
  reader?: LegacyProjectWorkReader;
}): LegacyProjectWorkSource {
  const resolver = input.resolver ?? new ActiveProjectLedgerResolver();
  const reader = input.reader ?? createLegacyProjectWorkReader();
  return {
    async loadOpenWork(request) {
      const programIds = [...new Set(request.programIds)]
        .filter((programId) => programId.length > 0)
        .sort();
      if (programIds.length === 0) return null;
      const projectRoot = resolveInitializedRoot(
        resolver,
        input.butlerData,
        request.projectRef,
      );
      if (!projectRoot) return null;
      for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
        const before = await reader.observeCanonicalHead(projectRoot);
        const core = await loadProjectLedgerCore();
        const snapshots: LegacyProjectWorkSnapshot[] = [];
        for (const programId of programIds) {
          const program = await reader.loadProgram(projectRoot, programId);
          if (!program || !isOpen(program)) continue;
          snapshots.push(projectSnapshot(core, projectRoot, before, program));
        }
        const after = await reader.observeCanonicalHead(projectRoot);
        if (!sameSemanticHead(before, after)) continue;
        if (snapshots.length > 1) {
          throw new Error("Project Ledger has multiple open R2 Programs for this Session");
        }
        return snapshots[0] ?? null;
      }
      throw new Error("Project Ledger changed while importing R2 Work");
    },
  };
}

export function createLegacyProjectWorkReader(): LegacyProjectWorkReader {
  return {
    observeCanonicalHead: observeProjectLedgerHead,
    async loadProgram(projectRoot, programId) {
      return loadLegacyProjectProgram(
        await loadProjectLedgerCore(),
        projectRoot,
        programId,
      );
    },
  };
}

export function loadLegacyProjectProgram(
  core: ProjectLedgerCore,
  projectRoot: string,
  programId: string,
): LegacyProjectProgram | null {
  try {
    const found = core.resolveRecord(projectRoot, {
      kind: "reference",
      id: `BTCC-PROGRAM-${programId}`,
    });
    const body = core.readRecordBody(found.filePath);
    if (!body) throw new Error("Project Ledger Program manifest body is missing");
    const value = JSON.parse(body) as Record<string, unknown>;
    if (stableJson(value) !== body || value.programId !== programId) {
      throw new Error("Project Ledger Program manifest identity changed");
    }
    return decodeProgram(value);
  } catch (error) {
    if (isMissingRecord(error)) return null;
    throw error;
  }
}

function resolveInitializedRoot(
  resolver: ActiveProjectLedgerResolver,
  butlerData: string,
  projectRef: string,
): string | null {
  const binding = decodeProjectLedgerBinding(projectRef);
  const reference = resolver.resolve({
    butlerData,
    ...(binding.kind === "canonical_ledger_id"
      ? { explicitRef: binding.ledgerProjectId }
      : {
          appProjectId: binding.appProjectId,
        }),
  });
  return reference.initialized ? reference.ledger_root : null;
}

function projectSnapshot(
  core: ProjectLedgerCore,
  projectRoot: string,
  head: ProjectLedgerHead,
  program: LegacyProjectProgram,
): LegacyProjectWorkSnapshot {
  const goalContract = loadGoalContract(core, projectRoot, program.goalContractRef);
  if (program.planningState === "unplanned") {
    return {
      sourceProgramId: program.programId,
      sourceRevision: sourceRevision(head, program.programId, program.manifestRevision),
      goalContract,
      plan: null,
      works: [],
      tasks: [],
      referencedRecords: [],
    };
  }
  return {
    sourceProgramId: program.programId,
    sourceRevision: sourceRevision(head, program.programId, program.manifestRevision),
    goalContract,
    plan: program.plan ?? null,
    works: program.works.map((work) => ({
      recordId: work.work.ref.id,
      status: work.status,
      content: work.work,
    })),
    tasks: program.tasks.map((task) => ({
      recordId: task.task.ref.id,
      status: task.status,
      content: task.task,
    })),
    referencedRecords: program.criteria.map((criterion) => ({
      recordId: criterion.ref.id,
      content: criterion,
    })),
  };
}

function loadGoalContract(
  core: ProjectLedgerCore,
  projectRoot: string,
  sourceRef: Ref,
): unknown {
  const logicalId = `${LOGICAL_RECORD_PREFIX}${sourceRef.id}`;
  const found = core.resolveRecord(projectRoot, { kind: "reference", id: logicalId });
  const body = core.readRecordBody(found.filePath);
  if (!body) throw new Error("Project Ledger Goal Contract body is missing");
  const logical = JSON.parse(body) as {
    ref?: { id?: unknown };
    sourceId?: unknown;
    record?: unknown;
  };
  if (
    stableJson(logical) !== body ||
    logical.ref?.id !== logicalId ||
    logical.sourceId !== sourceRef.id ||
    !isRecord(logical.record)
  ) {
    throw new Error("Project Ledger Goal Contract logical record changed");
  }
  const expected = contentRef("goal-contract", logical.record);
  if (
    expected.id !== sourceRef.id ||
    expected.sha256 !== sourceRef.sha256 ||
    digest(stableJson(logical.record)) !== sourceRef.sha256
  ) {
    throw new Error("Project Ledger Goal Contract identity changed");
  }
  return { ref: sourceRef, ...logical.record };
}

function decodeProgram(value: Record<string, unknown>): LegacyProjectProgram {
  const goalContractRef = decodeRef(value.goalContractRef, "Goal Contract");
  const works = decodeItems(value.works, "work");
  const tasks = decodeItems(value.tasks, "task");
  const criteria = array(value.criteria).map((item) => {
    const record = requireRecord(item, "Project Ledger criterion");
    return { ...record, ref: decodeRef(record.ref, "criterion") };
  });
  if (
    typeof value.programId !== "string" ||
    !Number.isSafeInteger(value.manifestRevision) ||
    typeof value.planningState !== "string" ||
    typeof value.frontier !== "string"
  ) {
    throw new Error("Project Ledger Program manifest is incomplete");
  }
  return {
    programId: value.programId,
    manifestRevision: value.manifestRevision as number,
    planningState: value.planningState,
    frontier: value.frontier,
    goalContractRef,
    ...(value.plan === undefined ? {} : { plan: value.plan }),
    works: works as LegacyProjectProgram["works"],
    tasks: tasks as LegacyProjectProgram["tasks"],
    criteria,
  };
}

function decodeItems(value: unknown, key: "work" | "task") {
  return array(value).map((item) => {
    const record = requireRecord(item, `Project Ledger ${key} item`);
    const content = requireRecord(record[key], `Project Ledger ${key}`);
    if (typeof record.status !== "string") {
      throw new Error(`Project Ledger ${key} status is missing`);
    }
    return {
      status: record.status,
      [key]: { ...content, ref: decodeRef(content.ref, key) },
    };
  });
}

function decodeRef(value: unknown, label: string): Ref {
  const record = requireRecord(value, `Project Ledger ${label} ref`);
  if (typeof record.id !== "string" || typeof record.sha256 !== "string") {
    throw new Error(`Project Ledger ${label} ref is incomplete`);
  }
  return { id: record.id, sha256: record.sha256 };
}

function isOpen(program: LegacyProjectProgram): boolean {
  return program.planningState === "unplanned" ||
    (program.frontier !== "closed" && program.frontier !== "cancelled");
}

function sameSemanticHead(left: ProjectLedgerHead, right: ProjectLedgerHead): boolean {
  return left.projectRoot === right.projectRoot &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceFileCount === right.sourceFileCount;
}

function sourceRevision(
  head: ProjectLedgerHead,
  programId: string,
  manifestRevision: number,
): string {
  return digest(
    `btcc-r2-project-work-import.v1\0${head.projectRoot}\0${head.sourceSha256}` +
    `\0${head.sourceFileCount}\0${programId}\0${manifestRevision}`,
  );
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingRecord(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "record_not_found";
}
