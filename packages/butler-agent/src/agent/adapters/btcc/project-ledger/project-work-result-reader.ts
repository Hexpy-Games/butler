import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import { requireCurrentProjectWork } from "./project-work-snapshot.ts";

export type ExactProjectWorkResultIdentity = {
  resultRef: string;
  revision: number;
  workId: string;
  sessionId: string;
  scopeRef: string;
  ledgerProjectId: string;
  toolCallId: string;
  toolName: string;
  turnId: string;
  resultSha256: string;
};

export type ExactProjectWorkResultAuthority = {
  resolve(input: { turnId: string; callId: string }):
    | ExactProjectWorkResultIdentity
    | null;
  verify(
    input: Omit<ExactProjectWorkResultIdentity, "toolName">,
  ): ExactProjectWorkResultIdentity;
};

/** Prepares a sync authority through the existing stable exact Project reader. */
export async function createExactProjectWorkResultAuthority(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  workIds: string[];
}): Promise<ExactProjectWorkResultAuthority> {
  const uniqueWorkIds = [...new Set(input.workIds)];
  if (uniqueWorkIds.length !== 1 || input.workIds.length !== 1)
    invalid("operation_result_project_work_set_invalid");
  const snapshots = await Promise.all(
    uniqueWorkIds.map((workId) => requireCurrentProjectWork({
      butlerData: input.butlerData,
      scope: input.scope,
      workId,
    })),
  );
  const identities = snapshots.flatMap((snapshot) =>
    snapshot.children
      .filter(
        (child) =>
          child.schema === "butler.btcc-project-work-result-reference.v1",
      )
      .map((child) => ({
        resultRef: child.result.resultRef,
        revision: child.result.sequence,
        workId: child.workId,
        sessionId: child.sessionId,
        scopeRef: child.scope.appProjectId,
        ledgerProjectId: child.scope.ledgerProjectId,
        toolCallId: child.result.toolCallId,
        toolName: child.result.toolName,
        turnId: child.result.originTurnId,
        resultSha256: child.result.resultSha256!,
      })),
  );
  assertUnique(identities);
  return new PreparedProjectWorkResultAuthority(identities);
}

class PreparedProjectWorkResultAuthority
implements ExactProjectWorkResultAuthority {
  constructor(
    private readonly identities: ExactProjectWorkResultIdentity[],
  ) {}

  resolve(input: { turnId: string; callId: string }) {
    const matches = this.identities.filter(
      (identity) =>
        identity.turnId === input.turnId && identity.toolCallId === input.callId,
    );
    if (matches.length > 1) invalid("operation_result_project_identity_ambiguous");
    return matches[0] ?? null;
  }

  verify(input: Omit<ExactProjectWorkResultIdentity, "toolName">) {
    const matches = this.identities.filter(
      (identity) =>
        identity.resultRef === input.resultRef &&
        identity.revision === input.revision &&
        identity.workId === input.workId &&
        identity.sessionId === input.sessionId &&
        identity.scopeRef === input.scopeRef &&
        identity.ledgerProjectId === input.ledgerProjectId &&
        identity.toolCallId === input.toolCallId &&
        identity.turnId === input.turnId &&
        identity.resultSha256 === input.resultSha256,
    );
    if (matches.length !== 1)
      invalid("operation_result_project_reference_mismatch");
    return matches[0]!;
  }
}

function assertUnique(identities: ExactProjectWorkResultIdentity[]): void {
  const keys = identities.flatMap((identity) => [
    `ref\0${identity.resultRef}`,
    `call\0${identity.turnId}\0${identity.toolCallId}`,
    `sequence\0${identity.workId}\0${identity.revision}`,
  ]);
  if (new Set(keys).size !== keys.length)
    invalid("operation_result_project_identity_ambiguous");
}

function invalid(message: string): never {
  throw new Error(message);
}
